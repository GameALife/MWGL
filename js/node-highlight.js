/** 与画布节点类型一致的高亮色 */
const TYPE_COLORS = {
  start: { bg: "#d1fae5", border: "#10b981", label: "start" },
  step: { bg: "#dbeafe", border: "#2563eb", label: "step" },
  branch: { bg: "#fef3c7", border: "#d97706", label: "branch" },
  parallel: { bg: "#e0f2fe", border: "#0284c7", label: "parallel" },
  end: { bg: "#bbf7d0", border: "#16a34a", label: "end" },
  "end-success": { bg: "#bbf7d0", border: "#16a34a", label: "end·success" },
  "end-failure": { bg: "#fecaca", border: "#dc2626", label: "end·failure" },
  edge: { bg: "#f1f5f9", border: "#94a3b8", label: "分支边" },
  structural: { bg: "#f8fafc", border: "#cbd5e1", label: "结构" }
};

export function safeFn(id) {
  return "node_" + String(id).replace(/[^a-zA-Z0-9]/g, "_");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nodeColorKey(node) {
  if (node?.type === "end") {
    return node.outcome === "failure" ? "end-failure" : "end-success";
  }
  return node?.type || "step";
}

/** @returns {Map<string, { id, type, text, colorKey, colors, shortLabel }>} */
export function buildNodeMetaMap(workflow) {
  const map = new Map();
  const nodes = workflow?.nodes || [];
  const edges = workflow?.edges || [];
  for (const n of nodes) {
    const colorKey = nodeColorKey(n);
    const colors = TYPE_COLORS[colorKey] || TYPE_COLORS.step;
    const short = `${n.type}${n.outcome ? `·${n.outcome}` : ""}`;
    map.set(n.id, {
      id: n.id,
      type: n.type,
      text: n.text || "",
      colorKey,
      colors,
      shortLabel: short
    });
  }
  for (const e of edges) {
    map.set(e.id, {
      id: e.id,
      type: "edge",
      text: e.label || "",
      colorKey: "edge",
      colors: TYPE_COLORS.edge,
      shortLabel: `边 ${e.label || e.id}`
    });
  }
  return map;
}

/**
 * 伪代码按行标注所属节点/边。
 * v3：main.flow 段用 CALL/IF id；逐节点 .pseudo 段整文件归属该节点。
 */
export function buildPseudoLineNodes(text, workflow) {
  const edgeFrom = new Map((workflow?.edges || []).map((e) => [e.id, e.from]));
  const nodeIds = new Set((workflow?.nodes || []).map((n) => n.id));
  const lines = String(text || "").split("\n");
  const result = [];

  /** @type {"main"|"nodes"|"legacy"} */
  let section = "legacy";
  let currentNodeId = null;

  const pushStructural = () => result.push({ nodeId: null, edgeId: null, structural: true });
  const pushNode = (nodeId, structural = false, edgeId = null) =>
    result.push({ nodeId, edgeId, structural });

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^#\s*main\.flow\s*$/i.test(trimmed)) {
      section = "main";
      currentNodeId = null;
      pushStructural();
      continue;
    }
    if (/^#\s*=+.*逐节点/i.test(trimmed) || /^#\s*=+/.test(trimmed)) {
      section = "nodes";
      currentNodeId = null;
      pushStructural();
      continue;
    }
    if (/^#/.test(trimmed)) {
      pushStructural();
      continue;
    }

    const pseudoFileM = line.match(/^---\s+(\S+)\.pseudo\s*---/);
    if (pseudoFileM) {
      section = "nodes";
      currentNodeId = pseudoFileM[1];
      pushNode(currentNodeId, false);
      continue;
    }

    if (section === "nodes" && currentNodeId) {
      const loopKw = /^\s*(?:FOR|WHILE|END\s+(?:FOR|WHILE))\b/i.test(line);
      pushNode(currentNodeId, loopKw);
      continue;
    }

    if (section === "main" || (section === "legacy" && /^\s*CALL\s+\S+/.test(line))) {
      if (section === "legacy" && /^\s*CALL\s+/.test(line)) section = "main";

      if (/^\s*BEGIN\s+WORKFLOW/i.test(line)) {
        section = "main";
        pushStructural();
        continue;
      }
      if (/^\s*END\s+WORKFLOW/i.test(line)) {
        pushStructural();
        continue;
      }

      const callM = line.match(/^\s*CALL\s+(\S+)/);
      if (callM?.[1] && nodeIds.has(callM[1])) {
        currentNodeId = callM[1];
        pushNode(callM[1], false);
        continue;
      }

      const termM = line.match(/^\s*(SUCCESS|FAILURE)\s+(\S+)/);
      if (termM?.[2] && nodeIds.has(termM[2])) {
        currentNodeId = termM[2];
        pushNode(termM[2], false);
        continue;
      }

      const ifM = line.match(/^\s*IF\s+(\S+)/);
      if (ifM?.[1] && nodeIds.has(ifM[1])) {
        currentNodeId = ifM[1];
        pushNode(ifM[1], false);
        continue;
      }

      const parM = line.match(/^\s*PARALLEL\s+(\S+)/);
      if (parM?.[1] && nodeIds.has(parM[1])) {
        currentNodeId = parM[1];
        pushNode(parM[1], false);
        continue;
      }

      if (/^\s*END\s+(?:IF|PARALLEL)\b/i.test(line)) {
        pushStructural();
        continue;
      }

      const edgeM = line.match(/#\s*\[([^\]]+)\]/);
      if (/^\s*(?:BRANCH|ELSE)\b/i.test(line)) {
        if (edgeM?.[1] && edgeFrom.has(edgeM[1])) {
          pushNode(edgeFrom.get(edgeM[1]), true, edgeM[1]);
        } else {
          pushNode(currentNodeId, true);
        }
        continue;
      }
      if (/^\s*ARM\b/i.test(line)) {
        if (edgeM?.[1] && edgeFrom.has(edgeM[1])) {
          pushNode(edgeFrom.get(edgeM[1]), true, edgeM[1]);
        } else {
          pushNode(currentNodeId, true);
        }
        continue;
      }

      if (!trimmed) {
        pushStructural();
        continue;
      }
      pushNode(currentNodeId, !currentNodeId);
      continue;
    }

    const nodeM = line.match(/#\s*\[([^\]]+)\]/);
    if (nodeM) {
      const id = nodeM[1];
      if (edgeFrom.has(id)) {
        currentNodeId = edgeFrom.get(id) || id;
        pushNode(currentNodeId, false, id);
      } else if (nodeIds.has(id)) {
        currentNodeId = id;
        pushNode(id, false);
      } else {
        pushNode(currentNodeId, true);
      }
      continue;
    }

    if (/^\s*BEGIN\s+WORKFLOW/i.test(line)) {
      section = "main";
      pushStructural();
      continue;
    }
    if (/^\s*END\s+WORKFLOW/i.test(line)) {
      pushStructural();
      continue;
    }
    if (
      section === "legacy" &&
      /^\s*(IF|ELSE IF|ELSE|END IF|PARALLEL|ARM|END PARALLEL)\b/i.test(line)
    ) {
      pushNode(currentNodeId, true);
      continue;
    }
    if (section === "legacy" && /^\s*(FOR|WHILE|END FOR|END WHILE)\b/i.test(line)) {
      pushNode(currentNodeId, true);
      continue;
    }

    if (!trimmed) {
      pushStructural();
      continue;
    }
    pushNode(currentNodeId, !currentNodeId);
  }
  return result;
}

function fnNameToNodeId(fnName, workflow) {
  for (const n of workflow?.nodes || []) {
    if (safeFn(n.id) === fnName) return n.id;
  }
  return null;
}

/** 代码：按行标注所属节点 */
export function buildCodeLineNodes(text, workflow) {
  const lines = String(text || "").split("\n");
  const result = [];
  let currentFnNode = null;
  let inMain = false;

  const FUNC_RE = /(?:async\s+)?(?:def|function)\s+(node_[a-zA-Z0-9_]+)/;
  const CALL_RE = /(?:await\s+)?(node_[a-zA-Z0-9_]+)\s*\(/g;

  for (const line of lines) {
    if (/主函数/.test(line) || /async def main|function main|func main|int main/.test(line)) {
      inMain = true;
      currentFnNode = null;
      result.push({ nodeId: null, structural: true });
      continue;
    }
    if (/逐节点函数/.test(line)) {
      inMain = false;
      result.push({ nodeId: null, structural: true });
      continue;
    }

    const funcM = line.match(FUNC_RE);
    if (funcM) {
      currentFnNode = fnNameToNodeId(funcM[1], workflow);
      inMain = false;
      result.push({ nodeId: currentFnNode, structural: false });
      continue;
    }

    if (inMain) {
      let callNode = null;
      let m;
      const re = new RegExp(CALL_RE.source, "g");
      while ((m = re.exec(line)) !== null) {
        callNode = fnNameToNodeId(m[1], workflow);
      }
      result.push({ nodeId: callNode, structural: !callNode });
      continue;
    }

    if (currentFnNode) {
      result.push({ nodeId: currentFnNode, structural: /^\s*(#|\/\/)/.test(line) });
    } else {
      result.push({ nodeId: null, structural: true });
    }
  }
  return result;
}

export function renderHighlightedHtml(text, lineMeta, metaMap) {
  const lines = String(text || "").split("\n");
  const html = lines.map((line, i) => {
    const meta = lineMeta[i] || {};
    let colors = TYPE_COLORS.structural;
    let title = "结构/框架";
    if (meta.edgeId && metaMap.has(meta.edgeId)) {
      const m = metaMap.get(meta.edgeId);
      colors = m.colors;
      title = `${m.shortLabel} · ${meta.edgeId}`;
      if (m.text) title += ` — ${m.text}`;
    } else if (meta.nodeId && metaMap.has(meta.nodeId)) {
      const m = metaMap.get(meta.nodeId);
      colors = m.colors;
      title = `${m.shortLabel} · ${meta.nodeId}`;
      if (m.text) title += ` — ${m.text.slice(0, 40)}`;
    }
    const bg = meta.structural && !meta.nodeId && !meta.edgeId ? TYPE_COLORS.structural.bg : colors.bg;
    const border = colors.border;
    const opacity = meta.structural && meta.nodeId && !meta.edgeId ? "0.72" : "1";
    const content = line.length ? escapeHtml(line) : "&nbsp;";
    return (
      `<div class="hl-line" style="background:${bg};border-left:3px solid ${border};opacity:${opacity}" ` +
      `title="${escapeHtml(title)}">${content}</div>`
    );
  });
  return html.join("");
}

export function renderLegendHtml(metaMap, workflow) {
  const nodes = workflow?.nodes || [];
  if (!nodes.length) return "";
  const seen = new Set();
  const chips = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    const m = metaMap.get(n.id);
    if (!m) continue;
    chips.push(
      `<span class="hl-legend-chip" style="border-color:${m.colors.border};background:${m.colors.bg}" ` +
        `title="${escapeHtml(n.text || "")}">` +
        `<code>${escapeHtml(n.id)}</code> ${escapeHtml(m.shortLabel)}` +
        `</span>`
    );
  }
  return chips.length ? `<div class="hl-legend">${chips.join("")}</div>` : "";
}

export function syncPseudoHighlight(elements, workflow) {
  const text = elements.pseudocodeText?.value || "";
  const metaMap = buildNodeMetaMap(workflow);
  const lineMeta = buildPseudoLineNodes(text, workflow);
  if (elements.pseudocodeHighlight) {
    elements.pseudocodeHighlight.innerHTML = renderHighlightedHtml(text, lineMeta, metaMap);
  }
  if (elements.pseudoLegend) {
    elements.pseudoLegend.innerHTML = renderLegendHtml(metaMap, workflow);
  }
}

export function syncCodeHighlight(elements, workflow) {
  const text = elements.codeText?.value || "";
  const metaMap = buildNodeMetaMap(workflow);
  const lineMeta = buildCodeLineNodes(text, workflow);
  if (elements.codeHighlight) {
    elements.codeHighlight.innerHTML = renderHighlightedHtml(text, lineMeta, metaMap);
  }
  if (elements.codeLegend) {
    elements.codeLegend.innerHTML = renderLegendHtml(metaMap, workflow);
  }
}

export function bindHighlightScroll(elements) {
  const pairs = [
    [elements.pseudocodeText, elements.pseudocodeHighlight],
    [elements.codeText, elements.codeHighlight]
  ];
  for (const [ta, pre] of pairs) {
    if (!ta || !pre) continue;
    ta.addEventListener("scroll", () => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    });
  }
}
