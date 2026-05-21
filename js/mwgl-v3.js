import { uid } from "./ids.js";
import { alignWorkflowBBoxToOrigin } from "./viewport.js";
import { normalizeNodeLoop, validateWorkflowLoops } from "./mwgl-loop.js";
import { findConvergence, topoSort } from "../lib/mwgl-graph-utils.mjs";

/** MWGL v3：可读优先的极简工作流图语言 */
export const MWGL_VERSION = 3;

/**
 * - start：唯一入口
 * - step：顺序动作（含原 case / wait_user；单出边）
 * - branch：条件分支（多出边，label 为条件）
 * - parallel：并行分支（多出边，label 为臂名称；汇合与代码生成后续实现）
 * - end：终态（outcome: success | failure）
 *
 * 循环：step 上的 loop.steps 树 + subworkflows 子图（不写入主图 edges，保证主图 DAG）。
 */
export const NODE_TYPES = ["start", "step", "branch", "parallel", "end"];

const V2_TYPES = new Set([
  "wait_user",
  "switch",
  "loop_start",
  "loop_end",
  "parallel",
  "case",
  "success",
  "failure"
]);

function isTerminalType(t) {
  return t === "end";
}

function isGenericFailureText(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return true;
  return new Set(["失败", "failure", "fail", "失败节点"]).has(value);
}

function isSemanticEdgeLabel(label) {
  const text = String(label || "").trim();
  if (!text) return false;
  if (/^\d+$/.test(text)) return false;
  if (/^分支\d*$/i.test(text)) return false;
  return true;
}

export function hasDirectedPath(edges, startId, endId) {
  const adj = new Map();
  for (const e of edges || []) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const visited = new Set();
  const stack = [startId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === endId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const nxt of adj.get(cur) || []) {
      if (!visited.has(nxt)) stack.push(nxt);
    }
  }
  return false;
}

export function wouldEdgeCreateCycle(edges, fromId, toId) {
  if (fromId === toId) return true;
  return hasDirectedPath(edges, toId, fromId);
}

export function filterEdgesAcyclic(edges) {
  const kept = [];
  for (const e of edges || []) {
    if (wouldEdgeCreateCycle(kept, e.from, e.to)) continue;
    kept.push(e);
  }
  return kept;
}

export function isAllowedMwglEdge(nodes, fromId, toId) {
  const from = nodes.find((n) => n.id === fromId);
  const to = nodes.find((n) => n.id === toId);
  if (!from || !to) return false;
  if (isTerminalType(from.type)) return false;
  return true;
}

/** 将 v2 图升级为 v3（不校验，仅结构映射） */
export function migrateWorkflowV2ToV3(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const nodesIn = Array.isArray(safe.nodes) ? safe.nodes : [];
  const edgesIn = Array.isArray(safe.edges) ? safe.edges : [];

  const nodes = nodesIn
    .map((n) => {
    const t = String(n.type || "");
    const text = String(n.text || "").trim() || "未命名";
    const base = {
      id: String(n.id || uid("n")),
      x: Number(n.x) || 0,
      y: Number(n.y) || 0
    };

    if (t === "start") return { ...base, type: "start", text };
    if (t === "success") return { ...base, type: "end", outcome: "success", text };
    if (t === "failure") {
      return { ...base, type: "end", outcome: "failure", text };
    }
    if (t === "parallel") {
      return { ...base, type: "parallel", text: text || "并行分支" };
    }
    if (t === "switch") {
      return { ...base, type: "branch", text: text || "条件判断" };
    }
    if (t === "wait_user") {
      return {
        ...base,
        type: "step",
        text: /^等待/.test(text) ? text : `等待用户：${text}`
      };
    }
    if (t === "loop_start") {
      return {
        ...base,
        type: "step",
        text: text || "for 循环",
        loop: { kind: "for", condition: "", steps: [] }
      };
    }
    if (t === "loop_end") {
      return null;
    }
    return { ...base, type: "step", text };
  })
    .filter(Boolean);

  const edges = edgesIn.map((e) => ({
    id: String(e.id || uid("e")),
    from: String(e.from || ""),
    to: String(e.to || ""),
    label: String(e.label || "")
  }));

  return {
    mwgl_version: MWGL_VERSION,
    rule_id: String(safe.rule_id || uid("R_")),
    rule_name: String(safe.rule_name || "未命名工作流"),
    nodes,
    edges
  };
}

function needsV2Migration(workflow) {
  const ver = Number(workflow?.mwgl_version) || 0;
  if (ver < MWGL_VERSION) return true;
  return (workflow?.nodes || []).some((n) => V2_TYPES.has(String(n.type || "")));
}

export function validateWorkflowConstraints(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  const errors = [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const outMap = new Map(nodes.map((n) => [n.id, []]));
  const inMap = new Map(nodes.map((n) => [n.id, []]));

  for (const e of edges) {
    if (!nodeMap.has(e.from) || !nodeMap.has(e.to)) continue;
    outMap.get(e.from).push(e);
    inMap.get(e.to).push(e);
  }

  const starts = nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) {
    errors.push(`必须且仅能有一个 start 节点，当前为 ${starts.length} 个。`);
  }

  for (const n of nodes) {
    if (!NODE_TYPES.includes(n.type)) {
      errors.push(`节点 ${n.id} 类型 "${n.type}" 非法；允许：${NODE_TYPES.join(", ")}。`);
      continue;
    }
    const outs = outMap.get(n.id) || [];
    if (n.type === "end") {
      if (outs.length > 0) errors.push(`end 节点 ${n.id} 不能有出边。`);
      const outcome = String(n.outcome || "").trim();
      if (outcome !== "success" && outcome !== "failure") {
        errors.push(`end 节点 ${n.id} 必须设置 outcome 为 success 或 failure。`);
      }
      if (outcome === "failure" && isGenericFailureText(n.text)) {
        errors.push(`end 节点 ${n.id}（failure）须写明具体失败语义，不能仅写「失败」。`);
      }
    }
    if (n.type === "step" && outs.length > 1) {
      errors.push(`step 节点 ${n.id} 最多 1 条出边。`);
    }
    if (n.type === "start" && (inMap.get(n.id) || []).length > 0) {
      errors.push(`start 节点 ${n.id} 不能有入边。`);
    }
    if (n.type === "branch" || n.type === "parallel") {
      const kind = n.type;
      if (outs.length < 2) {
        errors.push(`${kind} 节点 ${n.id} 至少需要 2 条出边。`);
      }
      const labels = outs.map((e) => String(e.label || "").trim()).filter(Boolean);
      if (labels.length !== outs.length) {
        errors.push(`${kind} 节点 ${n.id} 每条出边须有非空 label。`);
      } else if (kind === "branch" && !outs.every((e) => isSemanticEdgeLabel(e.label))) {
        errors.push(`branch 节点 ${n.id} 出边 label 须为可判定业务条件（禁纯数字/分支N）。`);
      } else if (kind === "parallel" && !outs.every((e) => isSemanticEdgeLabel(e.label))) {
        errors.push(`parallel 节点 ${n.id} 出边 label 须有臂名称语义（禁纯数字/分支N）。`);
      } else if (new Set(labels).size !== labels.length) {
        errors.push(`${kind} 节点 ${n.id} 出边 label 不能重复。`);
      }
    }
  }

  if (starts.length === 1) {
    const startId = starts[0].id;
    if (!(outMap.get(startId) || []).length) {
      errors.push("start 至少需要 1 条出边。");
    }

    const reachable = new Set();
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop();
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const e of edges) {
        if (e.from !== cur || !nodeMap.has(e.to)) continue;
        if (!reachable.has(e.to)) stack.push(e.to);
      }
    }

    const reachableEnds = nodes.filter((n) => n.type === "end" && reachable.has(n.id));
    if (!reachableEnds.length) {
      errors.push("至少需要一个从 start 可达的 end 节点。");
    }

    const reverse = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      if (!nodeMap.has(e.from) || !nodeMap.has(e.to)) continue;
      reverse.get(e.to).push(e.from);
    }
    const canReachEnd = new Set();
    const backStack = nodes.filter((n) => n.type === "end").map((n) => n.id);
    while (backStack.length) {
      const cur = backStack.pop();
      if (canReachEnd.has(cur)) continue;
      canReachEnd.add(cur);
      for (const prev of reverse.get(cur) || []) {
        if (!canReachEnd.has(prev)) backStack.push(prev);
      }
    }
    for (const id of reachable) {
      const node = nodeMap.get(id);
      if (!node || node.type === "end") continue;
      if (!canReachEnd.has(id)) {
        errors.push(`节点 ${id} 从 start 可达，但无法到达任何 end。`);
      }
    }
  }

  const outEdges = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!nodeMap.has(e.from) || !nodeMap.has(e.to)) continue;
    outEdges.get(e.from).push(e);
  }
  const topoOrder = topoSort(nodes, edges);
  const topoIndex = new Map(topoOrder.map((id, i) => [id, i]));
  for (const n of nodes) {
    if (n.type !== "parallel") continue;
    const outs = outMap.get(n.id) || [];
    const targets = outs.map((e) => e.to).filter((id) => nodeMap.has(id));
    if (targets.length < 2) continue;
    const conv = findConvergence(targets, outEdges, nodeMap, topoIndex);
    if (!conv) {
      errors.push(
        `parallel 节点 ${n.id} 各臂须汇合到同一后续节点（未找到公共汇合点，请让各臂下游连到同一 step）。`
      );
    }
  }

  const loopVal = validateWorkflowLoops(workflow);
  if (!loopVal.ok) errors.push(...loopVal.errors);

  const subs = workflow?.subworkflows;
  if (subs && typeof subs === "object") {
    for (const [swId, sub] of Object.entries(subs)) {
      if (!sub || typeof sub !== "object") continue;
      const subCheck = validateWorkflowConstraints({
        mwgl_version: MWGL_VERSION,
        rule_id: swId,
        rule_name: sub.rule_name || swId,
        nodes: sub.nodes || [],
        edges: sub.edges || [],
        subworkflows: {}
      });
      if (!subCheck.ok) {
        for (const e of subCheck.errors) errors.push(`subworkflows.${swId}: ${e}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** parallel 节点汇合状态（供画布标记） */
export function parallelJoinStatus(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  const status = new Map();
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const outMap = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!nodeMap.has(e.from) || !nodeMap.has(e.to)) continue;
    outMap.get(e.from).push(e);
  }
  const outEdges = outMap;
  const topoOrder = topoSort(nodes, edges);
  const topoIndex = new Map(topoOrder.map((id, i) => [id, i]));
  for (const n of nodes) {
    if (n.type !== "parallel") continue;
    const outs = outMap.get(n.id) || [];
    const targets = outs.map((e) => e.to).filter((id) => nodeMap.has(id));
    if (targets.length < 2) {
      status.set(n.id, { ok: false, joinId: null });
      continue;
    }
    const joinId = findConvergence(targets, outEdges, nodeMap, topoIndex);
    status.set(n.id, { ok: Boolean(joinId), joinId: joinId || null });
  }
  return status;
}

function normalizeSubworkflowsField(raw, normalizeGraphFn) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, val] of Object.entries(raw)) {
    const id = String(key || "").trim();
    if (!id || !val || typeof val !== "object") continue;
    out[id] = normalizeGraphFn({
      mwgl_version: MWGL_VERSION,
      rule_id: id,
      rule_name: val.rule_name || id,
      nodes: val.nodes || [],
      edges: val.edges || []
    });
    delete out[id].subworkflows;
  }
  return out;
}

function typeRank(type) {
  const order = { start: 0, step: 2, branch: 1, parallel: 1, end: 4 };
  return order[type] ?? 5;
}

function sortTopoQueue(nodes, ids) {
  return [...ids].sort((a, b) => {
    const ta = nodes.find((n) => n.id === a)?.type;
    const tb = nodes.find((n) => n.id === b)?.type;
    const r = typeRank(ta) - typeRank(tb);
    return r !== 0 ? r : String(a).localeCompare(String(b));
  });
}

export function layoutWorkflowLeftToRight(workflow) {
  const nodes = workflow?.nodes;
  const edges = workflow?.edges;
  if (!nodes?.length) return;
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const succs = new Map(ids.map((id) => [id, []]));
  const preds = new Map(ids.map((id) => [id, []]));
  for (const e of edges || []) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    succs.get(e.from).push(e.to);
    preds.get(e.to).push(e.from);
  }
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const e of edges || []) {
    if (idSet.has(e.from) && idSet.has(e.to)) indegree.set(e.to, indegree.get(e.to) + 1);
  }
  const roots = ids.filter((id) => indegree.get(id) === 0);
  const topo = [];
  const q2 = sortTopoQueue(nodes, roots);
  while (q2.length) {
    sortTopoQueue(nodes, q2);
    const u = q2.shift();
    topo.push(u);
    for (const v of succs.get(u) || []) {
      indegree.set(v, indegree.get(v) - 1);
      if (indegree.get(v) === 0) q2.push(v);
    }
  }
  if (topo.length !== ids.length) {
    alignWorkflowBBoxToOrigin(workflow);
    return;
  }

  const topoIndex = new Map(topo.map((id, i) => [id, i]));
  const depth = new Map(ids.map((id) => [id, 0]));
  for (const id of topo) {
    const ps = preds.get(id) || [];
    const d = ps.length === 0 ? 0 : Math.max(...ps.map((p) => depth.get(p) + 1));
    depth.set(id, d);
  }
  const layers = new Map();
  for (const id of ids) {
    const d = depth.get(id);
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(id);
  }
  const COL = 280;
  const ROW = 120;
  const PADX = 80;
  const PADY = 80;
  for (const d of [...layers.keys()].sort((a, b) => a - b)) {
    const layerIds = layers.get(d);
    layerIds.sort((a, b) => (topoIndex.get(a) ?? 0) - (topoIndex.get(b) ?? 0));
    layerIds.forEach((id, i) => {
      const n = nodes.find((x) => x.id === id);
      if (n) {
        n.x = PADX + d * COL;
        n.y = PADY + i * ROW;
      }
    });
  }
  alignWorkflowBBoxToOrigin(workflow);
}

function nextUniqueBranchLabel(used, preferred = ["是", "否"]) {
  for (const lab of preferred) {
    if (!used.has(lab)) return lab;
  }
  for (let i = 1; i <= 99; i += 1) {
    const candidate = `条件${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `条件_${uid("").slice(-4)}`;
}

function nextUniqueParallelLabel(used) {
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i);
    const candidate = `并行分支${letter}`;
    if (!used.has(candidate)) return candidate;
  }
  return `并行分支_${uid("").slice(-4)}`;
}

function repairForkJoinNodes(workflow, forkType) {
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  for (const node of nodes) {
    if (node.type !== forkType) continue;
    const outs = edges.filter((e) => e.from === node.id && nodeMap.has(e.to) && e.from !== e.to);
    const usedLabels = new Set();
    for (const e of outs) {
      let raw = String(e.label || "").trim();
      if (!raw || usedLabels.has(raw)) {
        raw =
          forkType === "parallel"
            ? nextUniqueParallelLabel(usedLabels)
            : nextUniqueBranchLabel(usedLabels);
        e.label = raw;
      }
      usedLabels.add(raw);
    }
    while (outs.length < 2) {
      const newStepId = uid("n_step");
      nodes.push({
        id: newStepId,
        type: "step",
        text: forkType === "parallel" ? "并行臂步骤" : "补充分支步骤",
        x: Number(node.x || 0) + 280,
        y: Number(node.y || 0) + outs.length * 96
      });
      nodeMap.set(newStepId, nodes[nodes.length - 1]);
      const label =
        forkType === "parallel"
          ? nextUniqueParallelLabel(usedLabels)
          : nextUniqueBranchLabel(usedLabels);
      const edge = { id: uid("e"), from: node.id, to: newStepId, label };
      edges.push(edge);
      outs.push(edge);
      usedLabels.add(label);
    }
  }
}

function repairBranchNodes(workflow) {
  repairForkJoinNodes(workflow, "branch");
}

function repairParallelNodes(workflow) {
  repairForkJoinNodes(workflow, "parallel");
}

export function normalizeWorkflow(raw) {
  let safe = raw && typeof raw === "object" ? raw : {};
  if (needsV2Migration(safe)) {
    safe = migrateWorkflowV2ToV3(safe);
  }

  const nodes = Array.isArray(safe.nodes) ? safe.nodes : [];
  const normalizedNodes = nodes
    .filter((n) => n && typeof n === "object")
    .map((n, idx) => {
      const t = String(n.type || "");
      const nodeType = NODE_TYPES.includes(t) ? t : "step";
      const nodeText = String(n.text || "未命名节点");
      const base = {
        id: String(n.id || uid("n")),
        type: nodeType,
        text: nodeText,
        x: Number.isFinite(Number(n.x)) ? Number(n.x) : 80 + idx * 30,
        y: Number.isFinite(Number(n.y)) ? Number(n.y) : 120 + idx * 30
      };
      if (nodeType === "end") {
        const outcome = String(n.outcome || "").trim() === "failure" ? "failure" : "success";
        return { ...base, outcome };
      }
      if (n.loop) return normalizeNodeLoop({ ...base, loop: n.loop });
      return base;
    });

  const finalNodes = normalizedNodes.length
    ? normalizedNodes
    : [{ id: uid(), type: "start", text: "开始", x: 120, y: 180 }];

  const nodeIdSet = new Set(finalNodes.map((n) => n.id));
  let normalizedEdges = (Array.isArray(safe.edges) ? safe.edges : [])
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      id: String(e.id || uid("e")),
      from: String(e.from || ""),
      to: String(e.to || ""),
      label: String(e.label || "")
    }))
    .filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to) && e.from !== e.to)
    .filter((e) => isAllowedMwglEdge(finalNodes, e.from, e.to));

  const out = {
    mwgl_version: MWGL_VERSION,
    rule_id: String(safe.rule_id || uid("R_")),
    rule_name: String(safe.rule_name || "未命名工作流"),
    nodes: finalNodes,
    edges: normalizedEdges,
    subworkflows: normalizeSubworkflowsField(safe.subworkflows, (g) => {
      const inner = normalizeWorkflow(g);
      return { rule_name: inner.rule_name, nodes: inner.nodes, edges: inner.edges };
    })
  };
  if (out.subworkflows && !Object.keys(out.subworkflows).length) delete out.subworkflows;

  repairBranchNodes(out);
  repairParallelNodes(out);
  out.edges = filterEdgesAcyclic(out.edges || []);
  layoutWorkflowLeftToRight(out);
  return out;
}

export function workflowToMwgl(workflow) {
  const safe = workflow && typeof workflow === "object" ? workflow : {};
  const nodes = Array.isArray(safe.nodes) ? safe.nodes : [];
  const edges = Array.isArray(safe.edges) ? safe.edges : [];
  const nodeIdSet = new Set(nodes.map((n) => n.id));

  const nodeLines = nodes.map((n) => {
    const text = String(n.text || "").replaceAll('"', '\\"');
    if (n.type === "end") {
      const outcome = n.outcome === "failure" ? "failure" : "success";
      return `NODE ${n.id} end ${outcome} "${text}"`;
    }
    return `NODE ${n.id} ${n.type} "${text}"`;
  });

  const edgeLines = edges
    .filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to))
    .map((e) => {
      const label = String(e.label || "").replaceAll('"', '\\"');
      return `EDGE ${e.from} -> ${e.to} "${label}"`;
    });

  return [
    `RULE ${safe.rule_id || "R_UNKNOWN"} "${safe.rule_name || "未命名工作流"}"`,
    `VERSION ${MWGL_VERSION}`,
    "MODE graph",
    ...nodeLines,
    ...edgeLines
  ].join("\n");
}

export function mwglToWorkflow(text) {
  const lines = String(text).split("\n").map((x) => x.trim()).filter(Boolean);
  let ruleId = uid("R_");
  let ruleName = "从文本导入";
  let mode = "";
  const graphNodes = [];
  const graphEdges = [];

  for (const line of lines) {
    if (line.startsWith("RULE ")) {
      const m = line.match(/^RULE\s+(\S+)\s+"([^"]+)"/);
      if (m) {
        ruleId = m[1];
        ruleName = m[2];
      }
    } else if (/^VERSION\s+\d+$/i.test(line)) {
      /* optional */
    } else if (line === "MODE graph") {
      mode = "graph";
    } else if (line.startsWith("NODE ")) {
      let m = line.match(/^NODE\s+(\S+)\s+end\s+(success|failure)\s+"([\s\S]*)"$/i);
      if (m) {
        graphNodes.push({
          id: m[1],
          type: "end",
          outcome: m[2].toLowerCase(),
          text: m[3].replaceAll('\\"', '"')
        });
        continue;
      }
      m = line.match(/^NODE\s+(\S+)\s+(\S+)\s+"([\s\S]*)"$/);
      if (m) {
        const ty = m[2];
        graphNodes.push({
          id: m[1],
          type: NODE_TYPES.includes(ty) ? ty : "step",
          text: m[3].replaceAll('\\"', '"')
        });
      }
    } else if (line.startsWith("EDGE ")) {
      const m = line.match(/^EDGE\s+(\S+)\s+->\s+(\S+)\s+"([\s\S]*)"$/);
      if (m) {
        graphEdges.push({
          id: uid("e"),
          from: m[1],
          to: m[2],
          label: m[3].replaceAll('\\"', '"')
        });
      }
    }
  }

  if ((mode === "graph" || graphNodes.length > 0) && graphNodes.length) {
    const fallback = { start: 120, step: 400, branch: 380, parallel: 380, end: 720 };
    const nodes = graphNodes.map((n, idx) => {
      const ty = NODE_TYPES.includes(n.type) ? n.type : "step";
      const base = {
        id: String(n.id || uid()),
        type: ty,
        text: String(n.text || "未命名节点"),
        x: Number(fallback[ty] ?? 120) + idx * 8,
        y: 120 + idx * 8
      };
      if (ty === "end") {
        base.outcome = n.outcome === "failure" ? "failure" : "success";
      }
      return base;
    });
    return normalizeWorkflow({
      mwgl_version: MWGL_VERSION,
      rule_id: ruleId,
      rule_name: ruleName,
      nodes,
      edges: graphEdges
    });
  }

  return normalizeWorkflow({
    mwgl_version: MWGL_VERSION,
    rule_id: ruleId,
    rule_name: ruleName,
    nodes: [],
    edges: []
  });
}
