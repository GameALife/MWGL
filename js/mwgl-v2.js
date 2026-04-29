import { uid } from "./ids.js";
import { alignWorkflowBBoxToOrigin } from "./viewport.js";

/** MWGL 语言版本（工作流 JSON 字段 mwgl_version） */
export const MWGL_VERSION = 2;

/**
 * v2 节点类型：
 * - start：唯一入口
 * - wait_user：等待用户交互的中间节点
 * - switch：条件分支节点（边标签承载分支条件语义）
 * - loop_start：循环入口节点（仅进入循环体，不承担退出分流）
 * - loop_end：循环段结束节点（循环退出后从 loop_end 的后继继续）
 * - parallel：并行分支（至少 2 条出边）
 * - case：动作
 * - success / failure：业务终态（禁止出边），表示目标达成或未达成（失败结局）
 *   注：系统异常（超时/崩溃/解析错误）属于执行错误，不等同于 failure 终态。
 */
export const NODE_TYPES = [
  "start",
  "wait_user",
  "switch",
  "loop_start",
  "loop_end",
  "parallel",
  "case",
  "success",
  "failure"
];

export const FAILURE_KINDS = ["game_lose", "goal_not_met", "precondition_not_met", "risk_blocked"];

function isTerminalType(t) {
  return t === "success" || t === "failure";
}

function normalizeFailureKind(value) {
  const v = String(value || "").trim();
  return FAILURE_KINDS.includes(v) ? v : "";
}

function inferFailureKindFromText(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return "";
  if (/结局|lose|死亡|团灭|败北/.test(t)) return "game_lose";
  if (/前置|未认证|未授权|不满足|资格/.test(t)) return "precondition_not_met";
  if (/风控|拦截|封禁|黑名单|命中规则/.test(t)) return "risk_blocked";
  if (/未达成|超时|失败|不足|未通过/.test(t)) return "goal_not_met";
  return "";
}

function isGenericFailureText(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return true;
  const genericTexts = new Set(["失败", "failure", "fail", "失败节点"]);
  return genericTexts.has(value);
}

/**
 * 边合法性：保持 DAG；终态无出边。
 */
export function isAllowedMwglEdge(nodes, fromId, toId) {
  const from = nodes.find((n) => n.id === fromId);
  const to = nodes.find((n) => n.id === toId);
  if (!from || !to) return false;
  if (isTerminalType(from.type)) return false;

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
  const loopEndIds = new Set(nodes.filter((n) => n.type === "loop_end").map((n) => n.id));
  const loopStartIds = new Set(nodes.filter((n) => n.type === "loop_start").map((n) => n.id));

  function canReachAnyLoopEnd(fromId) {
    if (!fromId || !nodeMap.has(fromId)) return false;
    const visited = new Set();
    const stack = [fromId];
    while (stack.length) {
      const cur = stack.pop();
      if (loopEndIds.has(cur)) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const e of edges) {
        if (e.from !== cur) continue;
        if (!nodeMap.has(e.to)) continue;
        if (!visited.has(e.to)) stack.push(e.to);
      }
    }
    return false;
  }

  function isReachableFromAnyLoopStart(targetId) {
    if (!targetId || !nodeMap.has(targetId)) return false;
    for (const startId of loopStartIds) {
      if (hasDirectedPath(edges, startId, targetId)) return true;
    }
    return false;
  }

  function isSemanticEdgeLabel(label) {
    const text = String(label || "").trim();
    if (!text) return false;
    // 拒绝无语义占位：纯数字或“分支N”
    if (/^\d+$/.test(text)) return false;
    if (/^分支\d*$/i.test(text)) return false;
    return true;
  }

  const starts = nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) {
    errors.push(`必须且仅能有一个 start 节点，当前为 ${starts.length} 个。`);
  }
  for (const start of starts) {
    if ((inMap.get(start.id) || []).length > 0) {
      errors.push(`start 节点 ${start.id} 不能有入边。`);
    }
  }

  for (const n of nodes) {
    const outs = outMap.get(n.id) || [];
    if (n.type === "failure" && isGenericFailureText(n.text)) {
      errors.push(
        `failure 节点 ${n.id} 的 text 不能是泛化文案（如“失败”）；请明确失败语义（如“失败结局-生命值归零”或“任务未达成-超时”）。`
      );
    }
    if (n.type === "case" && outs.length > 1) {
      errors.push(`case 节点 ${n.id} 最多只能有 1 条出边。`);
    }
    if (n.type === "wait_user" && outs.length > 1) {
      errors.push(`wait_user 节点 ${n.id} 最多只能有 1 条出边。`);
    }
    if (n.type !== "switch" && n.type !== "loop_start" && n.type !== "parallel") continue;
    if (n.type === "switch" && outs.length < 1) {
      errors.push(`switch 节点 ${n.id} 至少需要 1 条出边。`);
    }
    if (n.type === "loop_start" && outs.length !== 1) {
      errors.push(`loop_start 节点 ${n.id} 必须且仅能有 1 条出边（进入循环体）。`);
    }
    if (n.type === "parallel" && outs.length < 2) {
      errors.push(`${n.type} 节点 ${n.id} 至少需要 2 条出边。`);
    }
    if (n.type === "switch") {
      const labels = outs.map((e) => String(e.label || "").trim()).filter(Boolean);
      if (labels.length !== outs.length) {
        errors.push(`switch 节点 ${n.id} 的每条出边都必须有非空标签。`);
      } else if (!outs.every((e) => isSemanticEdgeLabel(e.label))) {
        errors.push(`switch 节点 ${n.id} 的出边标签必须是有语义的条件描述（不能是纯数字或“分支N”）。`);
      } else if (new Set(labels).size !== labels.length) {
        errors.push(`switch 节点 ${n.id} 的出边标签不能重复。`);
      }
    }
    if (n.type === "loop_start" && outs.length) {
      if (!canReachAnyLoopEnd(n.id)) {
        errors.push(`loop_start 节点 ${n.id} 必须存在可达的 loop_end 节点（保证循环有收束点）。`);
      }
    }

    if (n.type === "loop_end" && outs.length < 1) {
      errors.push(`loop_end 节点 ${n.id} 至少需要 1 条出边（连接循环后的下一步）。`);
    } else if (n.type === "loop_end" && !isReachableFromAnyLoopStart(n.id)) {
      errors.push(`loop_end 节点 ${n.id} 必须由至少一个 loop_start 可达（与循环开始节点完整成对）。`);
    }
  }

  if (starts.length === 1) {
    const startId = starts[0].id;
    const startOut = outMap.get(startId) || [];
    if (!startOut.length) {
      errors.push("start 节点至少需要 1 条出边。");
    }

    const reachable = new Set();
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop();
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const e of edges) {
        if (e.from !== cur) continue;
        if (!nodeMap.has(e.to)) continue;
        if (!reachable.has(e.to)) stack.push(e.to);
      }
    }

    // 允许存在从 start 不可达的孤立设计节点（仅不参与执行路径）。

    const reachableTerminal = nodes.filter(
      (n) => (n.type === "success" || n.type === "failure") && reachable.has(n.id)
    );
    if (!reachableTerminal.length) {
      errors.push("至少需要一个从 start 可达的终态节点（success 或 failure）。");
    }

    const reverse = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      if (!nodeMap.has(e.from) || !nodeMap.has(e.to)) continue;
      reverse.get(e.to).push(e.from);
    }
    const canReachTerminal = new Set();
    const backStack = nodes
      .filter((n) => n.type === "success" || n.type === "failure")
      .map((n) => n.id);
    while (backStack.length) {
      const cur = backStack.pop();
      if (canReachTerminal.has(cur)) continue;
      canReachTerminal.add(cur);
      for (const prev of reverse.get(cur) || []) {
        if (!canReachTerminal.has(prev)) backStack.push(prev);
      }
    }
    for (const id of reachable) {
      const node = nodeMap.get(id);
      if (!node || isTerminalType(node.type)) continue;
      if (!canReachTerminal.has(id)) {
        errors.push(`节点 ${id} 从 start 可达，但无法到达任何终态（success/failure）。`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function typeRank(type) {
  const order = {
    start: 0,
    wait_user: 0,
    switch: 1,
    loop_start: 1,
    loop_end: 2,
    parallel: 1,
    case: 3,
    success: 4,
    failure: 4
  };
  return order[type] ?? 5;
}

function sortTopoQueue(nodes, ids) {
  return [...ids].sort((a, b) => {
    const ta = nodes.find((n) => n.id === a)?.type;
    const tb = nodes.find((n) => n.id === b)?.type;
    const r = typeRank(ta) - typeRank(tb);
    if (r !== 0) return r;
    return String(a).localeCompare(String(b));
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

function buildDefaultEdges(nodes) {
  const edges = [];
  const firstByType = (type) => nodes.find((n) => n.type === type);
  const byType = (type) => nodes.filter((n) => n.type === type);
  const start = firstByType("start");
  const sw = firstByType("switch");
  const caseNodes = byType("case");

  if (start && sw) edges.push({ id: uid("e"), from: start.id, to: sw.id, label: "" });
  if (sw && caseNodes.length) {
    caseNodes.forEach((node, idx) => {
      const label = caseNodes.length === 2 ? (idx === 0 ? "是" : "否") : `备选${idx + 1}`;
      edges.push({
        id: uid("e"),
        from: sw.id,
        to: node.id,
        label
      });
    });
  }
  return edges;
}

/** 生成唯一占位标签；须通过 validateWorkflowConstraints 中的 isSemanticEdgeLabel（禁纯数字、禁「分支」+ 可选数字形式）。 */
function nextUniqueBranchLabel(used, preferred, fallbackPrefix = "备选") {
  for (const lab of preferred) {
    if (!used.has(lab)) return lab;
  }
  for (let i = 1; i <= 99; i += 1) {
    const candidate = `${fallbackPrefix}${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${fallbackPrefix}_${uid("").slice(-4)}`;
}

function repairBranchingNodes(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  for (const node of nodes) {
    if (node.type !== "switch" && node.type !== "loop_start" && node.type !== "parallel") continue;
    const preferred = node.type === "switch" ? ["是", "否"] : ["并行1", "并行2"];
    const outs = edges.filter((e) => e.from === node.id && nodeMap.has(e.to) && e.from !== e.to);
    const usedLabels = new Set();

    for (const e of outs) {
      const raw = String(e.label || "").trim();
      if (node.type === "switch" && (!raw || usedLabels.has(raw))) {
        const fixed = nextUniqueBranchLabel(usedLabels, preferred);
        e.label = fixed;
        usedLabels.add(fixed);
      } else {
        e.label = raw;
        if (raw) usedLabels.add(raw);
      }
    }

    const minOut = node.type === "loop_start" ? 1 : node.type === "parallel" ? 2 : 0;
    while (outs.length < minOut) {
      const newCaseId = uid();
      const yOffset = (outs.length + 1) * 96 - 48;
      nodes.push({
        id: newCaseId,
        type: "case",
        text: node.type === "loop_start" ? "补全循环入口 自动生成" : "补充分支 自动生成",
        x: Number(node.x || 0) + 280,
        y: Number(node.y || 0) + yOffset
      });
      nodeMap.set(newCaseId, nodes[nodes.length - 1]);

      const label = node.type === "switch" ? nextUniqueBranchLabel(usedLabels, preferred) : "";
      const edge = { id: uid("e"), from: node.id, to: newCaseId, label };
      edges.push(edge);
      outs.push(edge);
      if (label) usedLabels.add(label);
    }

  }
}

export function normalizeWorkflow(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const nodes = Array.isArray(safe.nodes) ? safe.nodes : [];
  const normalizedNodes = nodes
    .filter((n) => n && typeof n === "object")
    .map((n, idx) => {
      const t = String(n.type || "");
      const nodeType = NODE_TYPES.includes(t) ? t : "case";
      const nodeText = String(n.text || "未命名节点");
      const normalizedFailureKind =
        nodeType === "failure"
          ? normalizeFailureKind(n.failure_kind) || inferFailureKindFromText(nodeText)
          : undefined;
      return {
        id: String(n.id || uid("n")),
        type: nodeType,
        text: nodeText,
        ...(nodeType === "failure" ? { failure_kind: normalizedFailureKind } : {}),
        x: Number.isFinite(Number(n.x)) ? Number(n.x) : 80 + idx * 30,
        y: Number.isFinite(Number(n.y)) ? Number(n.y) : 120 + idx * 30
      };
    });
  const finalNodes = normalizedNodes.length
    ? normalizedNodes
    : [{ id: uid(), type: "start", text: "开始 事件触发", x: 120, y: 180 }];

  const nodeIdSet = new Set(finalNodes.map((n) => n.id));
  const inputEdges = Array.isArray(safe.edges) ? safe.edges : [];
  let normalizedEdges = inputEdges
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      id: String(e.id || uid("e")),
      from: String(e.from || ""),
      to: String(e.to || ""),
      label: String(e.label || "")
    }))
    .filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to) && e.from !== e.to)
    .filter((e) => isAllowedMwglEdge(finalNodes, e.from, e.to));

  repairBranchingNodes({ nodes: finalNodes, edges: normalizedEdges });

  let acyclicEdges = filterEdgesAcyclic(normalizedEdges);

  const out = {
    mwgl_version: MWGL_VERSION,
    rule_id: String(safe.rule_id || uid("R_")),
    rule_name: String(safe.rule_name || "未命名工作流"),
    nodes: finalNodes,
    edges: acyclicEdges.length ? acyclicEdges : buildDefaultEdges(finalNodes)
  };

  // 兜底：先前过滤可能导致分支节点退化为单分支，返回前再次修复并保持 DAG。
  repairBranchingNodes(out);
  acyclicEdges = filterEdgesAcyclic(out.edges || []);
  out.edges = acyclicEdges;

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
      const m = line.match(/^NODE\s+(\S+)\s+(\S+)\s+"([\s\S]*)"$/);
      if (m) {
        const ty = m[2];
        graphNodes.push({
          id: m[1],
          type: NODE_TYPES.includes(ty) ? ty : "case",
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
    const fallbackX = {
      start: 120,
      wait_user: 120,
      switch: 380,
      loop_start: 380,
      loop_end: 560,
      parallel: 380,
      case: 680,
      success: 920,
      failure: 920
    };
    const fallbackY = {
      start: 180,
      wait_user: 300,
      switch: 180,
      loop_start: 320,
      loop_end: 320,
      parallel: 460,
      case: 120,
      success: 120,
      failure: 260
    };
    const nodes = graphNodes.map((n, idx) => {
      const t = String(n.type || "case");
      const ty = NODE_TYPES.includes(t) ? t : "case";
      return {
        id: String(n.id || uid()),
        type: ty,
        text: String(n.text || "未命名节点"),
        x: Number(fallbackX[ty] ?? 120) + idx * 8,
        y: Number(fallbackY[ty] ?? 120) + idx * 8
      };
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
