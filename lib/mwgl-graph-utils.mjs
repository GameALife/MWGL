export function topoSort(nodes, edges) {
  const nodeIds = new Set((nodes || []).map((n) => n.id));
  const outEdges = new Map();
  for (const e of edges || []) {
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from).push(e);
  }
  const inDeg = new Map((nodes || []).map((n) => [n.id, 0]));
  for (const e of edges || []) {
    if (nodeIds.has(e.from) && nodeIds.has(e.to)) {
      inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    }
  }
  const order = [];
  const q = (nodes || []).filter((n) => inDeg.get(n.id) === 0).map((n) => n.id);
  while (q.length) {
    const u = q.shift();
    order.push(u);
    for (const e of outEdges.get(u) || []) {
      if (!nodeIds.has(e.to)) continue;
      inDeg.set(e.to, inDeg.get(e.to) - 1);
      if (inDeg.get(e.to) === 0) q.push(e.to);
    }
  }
  return order;
}

export function buildGraph(workflow) {
  const nodes = workflow?.nodes || [];
  const edges = workflow?.edges || [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const outEdges = new Map();
  for (const e of edges) {
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from).push(e);
  }
  return { nodes, edges, nodeMap, outEdges };
}

export function reachableFromStart(nodes, outEdges) {
  const start = nodes.find((n) => n.type === "start");
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const reachable = new Set();
  if (!start) return reachable;
  const bfsQ = [start.id];
  while (bfsQ.length) {
    const c = bfsQ.shift();
    if (reachable.has(c)) continue;
    reachable.add(c);
    for (const e of outEdges.get(c) || []) {
      if (nodeMap.has(e.to) && !reachable.has(e.to)) bfsQ.push(e.to);
    }
  }
  return reachable;
}

export function findConvergence(branchTargets, outEdges, nodeMap, topoIndex) {
  if (branchTargets.length <= 1) return null;
  const reachSets = branchTargets.map((tid) => {
    const s = new Set();
    const bfsQ = [tid];
    while (bfsQ.length) {
      const c = bfsQ.shift();
      if (s.has(c)) continue;
      s.add(c);
      for (const e of outEdges.get(c) || []) {
        if (nodeMap.has(e.to) && !s.has(e.to)) bfsQ.push(e.to);
      }
    }
    return s;
  });
  let common = new Set(reachSets[0]);
  for (let i = 1; i < reachSets.length; i++) {
    common = new Set([...common].filter((x) => reachSets[i].has(x)));
  }
  if (common.size === 0) return null;
  let best = null;
  let bestIdx = Infinity;
  for (const id of common) {
    const idx = topoIndex.get(id);
    if (idx !== undefined && idx < bestIdx) {
      bestIdx = idx;
      best = id;
    }
  }
  return best;
}

export function parseJsonResponse(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

export function safeFn(id) {
  return "node_" + String(id).replace(/[^a-zA-Z0-9]/g, "_");
}

export function prepareNodeList(workflow) {
  const { nodes, edges, nodeMap } = buildGraph(workflow);
  const outEdgeMap = new Map();
  for (const e of edges) {
    if (!outEdgeMap.has(e.from)) outEdgeMap.set(e.from, []);
    outEdgeMap.get(e.from).push({ id: e.id, to: e.to, label: e.label || "" });
  }
  return topoSort(nodes, edges)
    .filter((id) => nodeMap.has(id))
    .map((id) => {
      const node = nodeMap.get(id);
      return {
        id: node.id,
        type: node.type,
        text: node.text,
        outcome: node.outcome,
        hasLoop: Boolean(node.loop),
        outEdges: outEdgeMap.get(id) || []
      };
    });
}
