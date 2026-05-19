"""
将 MWGL v3 工作流 JSON 转为 RobustFlow graph_evaluator 所需的图字典：
{"nodes": [str, ...], "edges": [(int, int), ...]}

约定：start 节点标签固定为 "START"；其余节点为 "[type] 文本"。
"""
from __future__ import annotations

from collections import defaultdict, deque
from typing import Any, Dict, List, Set, Tuple


def _topo_sort_ids(node_ids: List[str], edge_pairs: List[Tuple[str, str]]) -> List[str]:
    ids: Set[str] = set(node_ids)
    adj: Dict[str, List[str]] = defaultdict(list)
    indeg: Dict[str, int] = {n: 0 for n in node_ids}
    for a, b in edge_pairs:
        if a in ids and b in ids:
            adj[a].append(b)
            indeg[b] += 1
    q = deque([n for n in node_ids if indeg.get(n, 0) == 0])
    out: List[str] = []
    seen = set()
    while q:
        u = q.popleft()
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
        for v in adj[u]:
            indeg[v] -= 1
            if indeg[v] == 0:
                q.append(v)
    for n in node_ids:
        if n not in seen:
            out.append(n)
    return out


def mwgl_to_eval_graph(workflow: Dict[str, Any]) -> Dict[str, List]:
    """MWGL dict -> RobustFlow 风格图（节点为语义字符串，边为整数下标）。"""
    nodes = workflow.get("nodes") or []
    edges_in = workflow.get("edges") or []
    if not nodes:
        return {"nodes": [], "edges": []}

    id2n = {str(n["id"]): n for n in nodes if isinstance(n, dict) and "id" in n}

    edge_pairs: List[Tuple[str, str]] = []
    for e in edges_in:
        if not isinstance(e, dict):
            continue
        a, b = str(e.get("from", "")), str(e.get("to", ""))
        if a in id2n and b in id2n:
            edge_pairs.append((a, b))

    start_ids = [str(n["id"]) for n in nodes if isinstance(n, dict) and n.get("type") == "start"]
    node_id_list = [str(n["id"]) for n in nodes if isinstance(n, dict) and "id" in n]
    ordered_ids = _topo_sort_ids(node_id_list, edge_pairs)

    if start_ids:
        sid = start_ids[0]
        rest = [x for x in ordered_ids if x != sid]
        ordered_ids = [sid] + rest

    labels: List[str] = []
    id_to_idx: Dict[str, int] = {}
    for nid in ordered_ids:
        if nid not in id2n:
            continue
        id_to_idx[nid] = len(labels)
        n = id2n[nid]
        typ = str(n.get("type", "case"))
        txt = str(n.get("text", "")).strip()
        if typ == "start":
            labels.append("START")
        elif txt:
            labels.append(f"[{typ}] {txt}")
        else:
            labels.append(f"[{typ}]")

    out_edges: List[Tuple[int, int]] = []
    for e in edges_in:
        if not isinstance(e, dict):
            continue
        a, b = str(e.get("from", "")), str(e.get("to", ""))
        if a not in id_to_idx or b not in id_to_idx:
            continue
        out_edges.append((id_to_idx[a], id_to_idx[b]))

    return {"nodes": labels, "edges": out_edges}
