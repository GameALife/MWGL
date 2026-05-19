import { Router } from "express";
import { normalizeWorkflow } from "../js/mwgl.js";
import { scoreWorkflow, DEFAULT_SCORE_WEIGHTS } from "./optimize-scoring.js";
import {
  mergeGraphEditEvalConfig,
  graphEditConfigFromEnv,
  scoreGraphEditPair,
  blendScoreWithGraphEdit
} from "../lib/mwgl-graph-edit-eval.mjs";

const router = Router();

router.post("/api/mwgl/mock-evaluator", (req, res) => {
  const workflow = req.body?.workflow ? normalizeWorkflow(req.body.workflow) : {};
  const reference = req.body?.reference_workflow
    ? normalizeWorkflow(req.body.reference_workflow)
    : null;
  const evalDataset = Array.isArray(req.body?.eval_dataset) ? req.body.eval_dataset : [];
  const prompt = String(req.body?.prompt || "").trim();
  const weights =
    req.body?.weights && typeof req.body.weights === "object"
      ? { ...DEFAULT_SCORE_WEIGHTS, ...req.body.weights }
      : DEFAULT_SCORE_WEIGHTS;

  const result = scoreWorkflow(workflow, { evalDataset, prompt, weights });
  const graphEditCfg = mergeGraphEditEvalConfig(req.body?.graph_edit_eval, graphEditConfigFromEnv());
  const useGraphEdit =
    (graphEditCfg.enabled || req.body?.graph_edit_eval?.enabled === true) && reference;

  let score = result.score;
  let metrics = result.metrics;
  let graphEditMeta = null;

  if (useGraphEdit) {
    const ge = scoreGraphEditPair(reference, workflow, graphEditCfg, {
      lexical_fallback: req.body?.graph_edit_eval?.lexical_fallback === true
    });
    if (ge.ok) {
      score = blendScoreWithGraphEdit(result.score, ge.similarity, graphEditCfg.weight);
      metrics = {
        ...metrics,
        graph_edit_node_f1: ge.node_f1,
        graph_edit_graph_f1: ge.graph_f1,
        graph_edit_similarity: ge.similarity
      };
      graphEditMeta = { enabled: true, weight: graphEditCfg.weight, mode: ge.mode };
    } else {
      graphEditMeta = { enabled: true, skipped: ge.error };
    }
  }

  res.json({
    score: Number(score.toFixed(6)),
    metrics,
    meta: {
      evaluator: "mock",
      details: result.details,
      graph_edit: graphEditMeta,
      notes: "与 optimize 本地评分共用 optimize-scoring.js；生产请替换为真实执行评测。"
    }
  });
});

export default router;
