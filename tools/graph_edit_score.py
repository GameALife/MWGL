#!/usr/bin/env python3
"""
stdin JSON:
{
  "reference": { ... MWGL workflow ... },
  "candidates": [ { ... }, ... ],
  "sentence_model": "sentence-transformers/all-mpnet-base-v2",
  "local_files_only": false
}
stdout JSON:
{
  "ok": true,
  "scores": [{"node_f1", "graph_f1", "similarity", "error": null}, ...]
}
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _robustflow_repo_root() -> Path:
    env = os.environ.get("ROBUSTFLOW_ROOT", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    tools = Path(__file__).resolve().parent
    mwgl_root = tools.parent
    workspace_root = mwgl_root.parent
    for candidate in (workspace_root / "RobustFlow", workspace_root):
        if (candidate / "evaluate" / "graph_evaluator.py").is_file():
            return candidate
    return workspace_root


def _import_graph_evaluator():
    repo = _robustflow_repo_root()
    evaluate_dir = repo / "evaluate"
    if str(evaluate_dir) not in sys.path:
        sys.path.insert(0, str(evaluate_dir))
    try:
        from graph_evaluator import t_eval_graph, t_eval_nodes  # noqa: E402
    except ImportError as e:
        raise RuntimeError(
            "无法导入 graph_evaluator。请克隆 RobustFlow 并设置 ROBUSTFLOW_ROOT，"
            "或 pip install -r tools/requirements-graph-edit.txt\n"
            f"evaluate 路径: {evaluate_dir}\n原始错误: {e}"
        ) from e
    return t_eval_nodes, t_eval_graph


def _load_sentence_transformer(model_name: str, local_files_only: bool):
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model_name, local_files_only=local_files_only, trust_remote_code=False)


def _score_pair(
    pred: Dict[str, List],
    gt: Dict[str, List],
    t_eval_nodes,
    t_eval_graph,
    st_model,
) -> Tuple[float, float, Optional[str]]:
    if not pred.get("nodes") or not gt.get("nodes"):
        return 0.0, 0.0, "empty_graph"
    try:
        n_score = t_eval_nodes(pred, gt, st_model)
        g_score = t_eval_graph(pred, gt, st_model)
        node_f1 = float(n_score.get("f1_score", 0.0))
        graph_f1 = float(g_score.get("f1_score", 0.0))
        return node_f1, graph_f1, None
    except Exception as e:
        return 0.0, 0.0, str(e)


def main() -> None:
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"ok": False, "error": "empty stdin"}))
        return

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"invalid json: {e}"}))
        return

    tools_dir = Path(__file__).resolve().parent
    if str(tools_dir) not in sys.path:
        sys.path.insert(0, str(tools_dir))

    from mwgl_workflow_adapter import mwgl_to_eval_graph  # noqa: E402

    reference = payload.get("reference")
    candidates = payload.get("candidates") or []
    if not isinstance(reference, dict):
        print(json.dumps({"ok": False, "error": "reference workflow required"}))
        return
    if not isinstance(candidates, list):
        print(json.dumps({"ok": False, "error": "candidates must be a list"}))
        return

    model_name = str(payload.get("sentence_model") or "sentence-transformers/all-mpnet-base-v2")
    local_files_only = bool(payload.get("local_files_only"))

    try:
        t_eval_nodes, t_eval_graph = _import_graph_evaluator()
        st_model = _load_sentence_transformer(model_name, local_files_only)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return

    gt = mwgl_to_eval_graph(reference)
    scores: List[Dict[str, Any]] = []
    for wf in candidates:
        if not isinstance(wf, dict):
            scores.append(
                {"node_f1": 0.0, "graph_f1": 0.0, "similarity": 0.0, "error": "invalid_candidate"}
            )
            continue
        pred = mwgl_to_eval_graph(wf)
        node_f1, graph_f1, err = _score_pair(pred, gt, t_eval_nodes, t_eval_graph, st_model)
        similarity = (node_f1 + graph_f1) / 2.0
        scores.append(
            {
                "node_f1": round(node_f1, 6),
                "graph_f1": round(graph_f1, 6),
                "similarity": round(similarity, 6),
                "error": err,
            }
        )

    print(
        json.dumps(
            {
                "ok": True,
                "scores": scores,
                "reference_nodes": len(gt.get("nodes") or []),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
