import { state } from "./state.js";
import { workflowToMwgl } from "./mwgl.js";
import {
  NODE_LAYOUT_HEIGHT,
  NODE_LAYOUT_WIDTH,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  formatWorldTransform,
  offsetToCenterBBox,
  workflowBBox
} from "./viewport.js";

export function createRenderer(elements) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const INNER_WIDTH = WORLD_WIDTH;
  const INNER_HEIGHT = WORLD_HEIGHT;
  const NODE_WIDTH = NODE_LAYOUT_WIDTH;
  const NODE_HEIGHT = NODE_LAYOUT_HEIGHT;

  const worldEl = elements.canvasWorld;
  const labelRelayout = {
    attempts: 0,
    signature: "",
    suppressNextReset: false
  };
  const MAX_LABEL_RELAYOUT_ATTEMPTS = 3;

  function viewportSize() {
    const vp = elements.canvasViewport || elements.canvas;
    const w = vp?.clientWidth ?? 0;
    const h = vp?.clientHeight ?? 0;
    if (w > 0 && h > 0) return { w, h };
    const rect = vp?.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      return { w: Math.round(rect.width), h: Math.round(rect.height) };
    }
    const c = elements.canvas;
    return {
      w: c?.clientWidth || c?.getBoundingClientRect?.().width || 0,
      h: c?.clientHeight || c?.getBoundingClientRect?.().height || 0
    };
  }

  function ensureEdgeLayer() {
    let edgeLayer = worldEl.querySelector(".edge-layer");
    if (edgeLayer) return edgeLayer;
    edgeLayer = document.createElementNS(SVG_NS, "svg");
    edgeLayer.setAttribute("class", "edge-layer");
    edgeLayer.setAttribute("viewBox", `0 0 ${INNER_WIDTH} ${INNER_HEIGHT}`);

    const defs = document.createElementNS(SVG_NS, "defs");
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", "arrow-head");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("orient", "auto-start-reverse");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    path.setAttribute("fill", "#64748b");
    marker.appendChild(path);
    defs.appendChild(marker);
    edgeLayer.appendChild(defs);
    worldEl.appendChild(edgeLayer);
    return edgeLayer;
  }

  /** 用户坐标 (node.x,y) 原点在世界中心 → 世界像素 */
  function nodeCenter(node) {
    return {
      x: WORLD_WIDTH / 2 + node.x + NODE_WIDTH / 2,
      y: WORLD_HEIGHT / 2 + node.y + NODE_HEIGHT / 2
    };
  }

  function applyViewportTransform() {
    worldEl.style.transform = formatWorldTransform(state.canvasOffset, state.canvasScale);
  }

  /** @returns {boolean} 是否已根据有效视口写入偏移 */
  function centerWorkflow() {
    const nodes = state.workflow?.nodes || [];
    if (!nodes.length) {
      state.canvasOffset = { x: 0, y: 0 };
      return false;
    }
    const bbox = workflowBBox(nodes, NODE_WIDTH, NODE_HEIGHT);
    const s = Number.isFinite(state.canvasScale) ? state.canvasScale : 1;
    const { w: vpW, h: vpH } = viewportSize();
    if (vpW <= 0 || vpH <= 0) return false;
    const off = offsetToCenterBBox(bbox, vpW, vpH, s);
    if (!off) return false;
    state.canvasOffset = off;
    return true;
  }

  function tryApplyPendingCenter() {
    if (!state.pendingCenterViewport) return;
    const nodes = state.workflow?.nodes || [];
    if (!nodes.length) {
      state.pendingCenterViewport = false;
      return;
    }
    if (centerWorkflow()) {
      applyViewportTransform();
      state.pendingCenterViewport = false;
    }
  }

  function drawEdges(nodes, edges) {
    const edgeLayer = ensureEdgeLayer();
    const defs = edgeLayer.querySelector("defs");
    edgeLayer.innerHTML = "";
    if (defs) edgeLayer.appendChild(defs);
    const geometries = computeEdgeGeometries(nodes, edges);
    edges.forEach((edge) => {
      const geom = geometries.get(edge.id);
      if (!geom) return;

      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("d", geom.d);
      hit.setAttribute("class", "edge-hit");
      hit.dataset.edgeId = edge.id;
      edgeLayer.appendChild(hit);

      const line = document.createElementNS(SVG_NS, "path");
      line.setAttribute("d", geom.d);
      line.setAttribute("class", `edge-line${state.selectedEdgeId === edge.id ? " selected" : ""}`);
      line.setAttribute("marker-end", "url(#arrow-head)");
      line.dataset.edgeId = edge.id;
      edgeLayer.appendChild(line);
    });
    return geometries;
  }

  function computeEdgeGeometries(nodes, edges) {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const occupied = nodes.map((n) => {
      const x = WORLD_WIDTH / 2 + n.x;
      const y = WORLD_HEIGHT / 2 + n.y;
      return { left: x - 4, top: y - 4, right: x + NODE_WIDTH + 4, bottom: y + NODE_HEIGHT + 4 };
    });
    const rectAt = (cx, cy, w, h, margin = 2) => ({
      left: cx - w / 2 - margin,
      top: cy - h / 2 - margin,
      right: cx + w / 2 + margin,
      bottom: cy + h / 2 + margin
    });
    const intersects = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    const canPlace = (r) => !occupied.some((o) => intersects(r, o));
    const geometries = new Map();
    const measure = document.createElement("div");
    measure.className = "edge-label-overlay";
    measure.style.position = "absolute";
    measure.style.visibility = "hidden";
    measure.style.left = "-10000px";
    measure.style.top = "-10000px";
    worldEl.appendChild(measure);

    edges.forEach((edge) => {
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      if (!from || !to) return;
      const start = nodeCenter(from);
      const end = nodeCenter(to);
      const baseMidX = (start.x + end.x) / 2;
      const baseMidY = (start.y + end.y) / 2;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const label = String(edge.label || "").trim();
      let w = 0;
      let h = 0;
      if (label) {
        measure.textContent = label;
        w = measure.offsetWidth || 0;
        h = measure.offsetHeight || 0;
      }

      // 控制曲率搜索范围，避免为标签避让导致连线大幅偏折和交叉。
      const bends = [0, 16, -16, 28, -28, 40, -40, 52, -52, 64, -64];
      const tCandidates = [0.5, 0.46, 0.54];
      let chosen = null;
      let chosenScore = Number.POSITIVE_INFINITY;
      for (const bend of bends) {
        const c1x = baseMidX + nx * bend;
        const c1y = start.y + ny * bend;
        const c2x = baseMidX + nx * bend;
        const c2y = end.y + ny * bend;
        for (const t of tCandidates) {
          const mt = 1 - t;
          const cx =
            mt * mt * mt * start.x +
            3 * mt * mt * t * c1x +
            3 * mt * t * t * c2x +
            t * t * t * end.x;
          const cy =
            mt * mt * mt * start.y +
            3 * mt * mt * t * c1y +
            3 * mt * t * t * c2y +
            t * t * t * end.y;
          const rect = label ? rectAt(cx, cy, w, h) : null;
          if (rect && !canPlace(rect)) continue;
          const score = Math.abs(bend) * 10 + Math.abs(t - 0.5) * 200;
          if (score < chosenScore) {
            chosenScore = score;
            chosen = { c1x, c1y, c2x, c2y, cx, cy, rect };
          }
        }
      }
      if (!chosen) {
        // 严格避让：极端拥挤无解时隐藏该边标签，不允许重叠显示。
        const c1x = baseMidX;
        const c1y = start.y;
        const c2x = baseMidX;
        const c2y = end.y;
        const d = `M ${start.x} ${start.y} C ${Math.round(c1x)} ${Math.round(c1y)}, ${Math.round(c2x)} ${Math.round(c2y)}, ${end.x} ${end.y}`;
        geometries.set(edge.id, { d, labelCenter: null });
        return;
      }
      if (chosen.rect) occupied.push(chosen.rect);
      const d = `M ${start.x} ${start.y} C ${Math.round(chosen.c1x)} ${Math.round(chosen.c1y)}, ${Math.round(chosen.c2x)} ${Math.round(chosen.c2y)}, ${end.x} ${end.y}`;
      geometries.set(edge.id, { d, labelCenter: { x: chosen.cx, y: chosen.cy } });
    });

    if (measure.parentNode) measure.parentNode.removeChild(measure);
    return geometries;
  }

  function drawEdgeLabelOverlays(nodes, edges, geometries) {
    let layer = worldEl.querySelector(".edge-label-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "edge-label-layer";
      worldEl.appendChild(layer);
    }
    layer.innerHTML = "";
    let unresolved = 0;
    edges.forEach((edge) => {
      const lab = String(edge.label || "").trim();
      if (!lab) return;
      const geom = geometries.get(edge.id);
      if (!geom || !geom.labelCenter) {
        unresolved += 1;
        return;
      }
      const div = document.createElement("div");
      div.className = "edge-label-overlay";
      div.textContent = lab;
      div.style.left = `${Math.round(geom.labelCenter.x)}px`;
      div.style.top = `${Math.round(geom.labelCenter.y)}px`;
      layer.appendChild(div);
    });
    return unresolved;
  }

  function spreadNodesForLabelClearance(nodes, scale = 1.12) {
    if (!Array.isArray(nodes) || !nodes.length) return;
    const cx = nodes.reduce((s, n) => s + Number(n.x || 0), 0) / nodes.length;
    const cy = nodes.reduce((s, n) => s + Number(n.y || 0), 0) / nodes.length;
    for (const n of nodes) {
      const dx = Number(n.x || 0) - cx;
      const dy = Number(n.y || 0) - cy;
      n.x = Math.round(cx + dx * scale);
      n.y = Math.round(cy + dy * scale);
    }
  }

  function syncEdgeEditor() {
    const nodes = state.workflow.nodes || [];
    const edges = state.workflow.edges || [];
    const currentFrom = elements.edgeFrom.value;
    const currentTo = elements.edgeTo.value;
    const currentEdge = state.selectedEdgeId || elements.edgeSelect.value;
    const nodeOptions = nodes
      .map((n) => `<option value="${n.id}">${n.id} · ${n.type} · ${n.text.slice(0, 24)}</option>`)
      .join("");
    elements.edgeFrom.innerHTML = nodeOptions;
    elements.edgeTo.innerHTML = nodeOptions;

    const edgeOptions = [
      `<option value="">新建连线</option>`,
      ...edges.map((e) => `<option value="${e.id}">${e.id}: ${e.from} -> ${e.to} ${e.label ? `[${e.label}]` : ""}</option>`)
    ].join("");
    elements.edgeSelect.innerHTML = edgeOptions;
    if (nodes.some((n) => n.id === currentFrom)) elements.edgeFrom.value = currentFrom;
    if (nodes.some((n) => n.id === currentTo)) elements.edgeTo.value = currentTo;
    if (edges.some((e) => e.id === currentEdge)) {
      elements.edgeSelect.value = currentEdge;
      state.selectedEdgeId = currentEdge;
    } else {
      state.selectedEdgeId = null;
    }
  }

  function setStatus(text, isError = false) {
    elements.status.textContent = text || "";
    elements.status.style.color = isError ? "#b91c1c" : "#1d4ed8";
  }

  function setConstraintErrors(errors = []) {
    const panel = elements.constraintPanel;
    const list = elements.constraintList;
    if (!panel || !list) return;
    const items = Array.isArray(errors) ? errors.filter(Boolean) : [];
    list.innerHTML = "";
    if (!items.length) {
      panel.classList.add("hidden");
      return;
    }
    items.forEach((item) => {
      const msg = typeof item === "string" ? item : item.message;
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = String(msg || "");
      li.appendChild(text);
      if (item && typeof item.onLocate === "function") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-locate";
        btn.textContent = "定位";
        btn.addEventListener("click", () => item.onLocate());
        li.appendChild(btn);
      }
      list.appendChild(li);
    });
    panel.classList.remove("hidden");
  }

  function getSelectedNode() {
    return state.workflow.nodes.find((n) => n.id === state.selectedNodeId) || null;
  }

  function syncEditor() {
    const node = getSelectedNode();
    if (!node) {
      elements.nodeType.value = "start";
      elements.nodeText.value = "";
      elements.nodeX.value = "";
      elements.nodeY.value = "";
      return;
    }
    elements.nodeType.value = node.type;
    elements.nodeText.value = node.text;
    elements.nodeX.value = String(node.x);
    elements.nodeY.value = String(node.y);
  }

  function render() {
    if (!worldEl) {
      console.error("MWGL: #canvasWorld 未找到，无法渲染画布。");
      return;
    }
    const wf = state.workflow;
    const currentSignature = (wf.nodes || [])
      .map((n) => `${n.id}:${n.x},${n.y}`)
      .join("|");
    if (currentSignature !== labelRelayout.signature) {
      if (labelRelayout.suppressNextReset) {
        labelRelayout.suppressNextReset = false;
      } else {
        labelRelayout.attempts = 0;
      }
      labelRelayout.signature = currentSignature;
    }
    worldEl.innerHTML = "";
    ensureEdgeLayer();
    wf.nodes.forEach((node) => {
      const div = document.createElement("div");
      const loopInCase =
        node.type === "case" && String(node.text || "").trimStart().startsWith("【循环】");
      div.className = `node ${node.type}${loopInCase ? " case-loop" : ""}${
        state.selectedNodeId === node.id ? " selected" : ""
      }`;
      div.style.left = `${WORLD_WIDTH / 2 + node.x}px`;
      div.style.top = `${WORLD_HEIGHT / 2 + node.y}px`;
      div.dataset.id = node.id;
      div.innerHTML = `
        <button class="node-delete" type="button" title="删除节点" aria-label="删除节点">×</button>
        <div class="type">${node.type}</div>
        <div class="text">${node.text}</div>
      `;
      worldEl.appendChild(div);
    });
    const geometries = drawEdges(wf.nodes, wf.edges || []);
    const unresolvedLabels = drawEdgeLabelOverlays(wf.nodes, wf.edges || [], geometries);
    if (unresolvedLabels > 0 && labelRelayout.attempts < MAX_LABEL_RELAYOUT_ATTEMPTS) {
      labelRelayout.attempts += 1;
      labelRelayout.suppressNextReset = true;
      spreadNodesForLabelClearance(wf.nodes, 1.12);
      render();
      return;
    }
    if (unresolvedLabels === 0) {
      labelRelayout.attempts = 0;
    }

    elements.jsonView.textContent = JSON.stringify(
      { ...wf, mwgl_version: wf.mwgl_version ?? 2 },
      null,
      2
    );
    elements.mwglText.value = workflowToMwgl(wf);

    if (!state.selectedNodeId && wf.nodes.length) {
      state.selectedNodeId = wf.nodes[0].id;
    }
    syncEditor();
    syncEdgeEditor();

    if (state.pendingCenterViewport) {
      tryApplyPendingCenter();
      if (state.pendingCenterViewport) {
        requestAnimationFrame(() => {
          tryApplyPendingCenter();
          requestAnimationFrame(() => {
            tryApplyPendingCenter();
            if (state.pendingCenterViewport) {
              setTimeout(() => tryApplyPendingCenter(), 0);
              setTimeout(() => tryApplyPendingCenter(), 50);
            }
          });
        });
      }
    }
    applyViewportTransform();
  }

  let lastCanvasSize = { w: 0, h: 0 };
  const resizeObserver = new ResizeObserver(() => {
    const w = elements.canvas.clientWidth;
    const h = elements.canvas.clientHeight;
    if (w <= 0 || h <= 0) {
      lastCanvasSize = { w: 0, h: 0 };
      return;
    }
    const wasInvalid = lastCanvasSize.w <= 0 || lastCanvasSize.h <= 0;
    lastCanvasSize = { w, h };
    if (wasInvalid) tryApplyPendingCenter();
  });
  resizeObserver.observe(elements.canvasViewport || elements.canvas);

  return {
    setStatus,
    setConstraintErrors,
    getSelectedNode,
    syncEditor,
    syncEdgeEditor,
    centerWorkflow,
    tryApplyPendingCenter,
    applyViewportTransform,
    render
  };
}
