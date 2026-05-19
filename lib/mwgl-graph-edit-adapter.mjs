/**
 * MWGL v3 → RobustFlow graph_evaluator 图格式（与 tools/mwgl_workflow_adapter.py 对齐）
 */

function topoSortIds(nodeIds, edgePairs) {
  const ids = new Set(nodeIds);
  const adj = new Map();
  const indeg = new Map();
  for (const id of nodeIds) {
    adj.set(id, []);
    indeg.set(id, 0);
  }
  for (const [a, b] of edgePairs) {
    if (!ids.has(a) || !ids.has(b)) continue;
    adj.get(a).push(b);
    indeg.set(b, (indeg.get(b) || 0) + 1);
  }
  const q = nodeIds.filter((id) => (indeg.get(id) || 0) === 0);
  const out = [];
  const seen = new Set();
  while (q.length) {
    const u = q.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    for (const v of adj.get(u) || []) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) q.push(v);
    }
  }
  for (const id of nodeIds) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

/** @param {object} workflow */
export function mwglToEvalGraph(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edgesIn = Array.isArray(workflow?.edges) ? workflow.edges : [];
  if (nodes.length === 0) return { nodes: [], edges: [] };

  const id2n = new Map();
  for (const n of nodes) {
    if (n && n.id != null) id2n.set(String(n.id), n);
  }

  const edgePairs = [];
  for (const e of edgesIn) {
    if (!e) continue;
    const a = String(e.from ?? "");
    const b = String(e.to ?? "");
    if (id2n.has(a) && id2n.has(b)) edgePairs.push([a, b]);
  }

  const startIds = nodes.filter((n) => n?.type === "start").map((n) => String(n.id));
  const nodeIdList = nodes.filter((n) => n?.id != null).map((n) => String(n.id));
  let orderedIds = topoSortIds(nodeIdList, edgePairs);
  if (startIds.length) {
    const sid = startIds[0];
    orderedIds = [sid, ...orderedIds.filter((x) => x !== sid)];
  }

  const labels = [];
  const idToIdx = new Map();
  for (const nid of orderedIds) {
    if (!id2n.has(nid)) continue;
    idToIdx.set(nid, labels.length);
    const n = id2n.get(nid);
    const typ = String(n.type || "case");
    const txt = String(n.text || "").trim();
    if (typ === "start") labels.push("START");
    else if (txt) labels.push(`[${typ}] ${txt}`);
    else labels.push(`[${typ}]`);
  }

  const outEdges = [];
  for (const e of edgesIn) {
    if (!e) continue;
    const a = String(e.from ?? "");
    const b = String(e.to ?? "");
    if (!idToIdx.has(a) || !idToIdx.has(b)) continue;
    outEdges.push([idToIdx.get(a), idToIdx.get(b)]);
  }

  return { nodes: labels, edges: outEdges };
}
