import { Router } from "express";
import { normalizeWorkflow } from "../js/mwgl.js";
import {
  graphEditConfigFromEnv,
  mergeGraphEditEvalConfig,
  scoreGraphEditBatch,
  scoreGraphEditPair,
  blendScoreWithGraphEdit
} from "../lib/mwgl-graph-edit-eval.mjs";
import { scoreWorkflow, DEFAULT_SCORE_WEIGHTS } from "./optimize-scoring.js";

const router = Router();

router.get("/api/mwgl/graph-edit-eval/status", (_req, res) => {
  const defaults = graphEditConfigFromEnv();
  res.json({
    default_enabled: defaults.enabled,
    script: "tools/graph_edit_score.py",
    env: {
      MWGL_GRAPH_EDIT_EVAL: process.env.MWGL_GRAPH_EDIT_EVAL ?? "",
      ROBUSTFLOW_ROOT: process.env.ROBUSTFLOW_ROOT ?? "",
      MWGL_GRAPH_EDIT_WEIGHT: process.env.MWGL_GRAPH_EDIT_WEIGHT ?? "0.2",
      MWGL_GRAPH_EDIT_SENTENCE_MODEL: process.env.MWGL_GRAPH_EDIT_SENTENCE_MODEL ?? "",
      MWGL_PYTHON_BIN: process.env.MWGL_PYTHON_BIN ?? "python3"
    },
    notes:
      "需克隆 RobustFlow 并 pip install -r tools/requirements-graph-edit.txt；默认 MWGL_GRAPH_EDIT_EVAL 未开启。"
  });
});

router.post("/api/mwgl/graph-edit-score", (req, res) => {
  try {
    const reference = req.body?.reference_workflow
      ? normalizeWorkflow(req.body.reference_workflow)
      : null;
    const single = req.body?.candidate_workflow
      ? normalizeWorkflow(req.body.candidate_workflow)
      : null;
    const many = Array.isArray(req.body?.candidates)
      ? req.body.candidates.map((w) => normalizeWorkflow(w))
      : [];

    const candidates = single ? [single] : many;
    if (!reference) {
      return res.status(400).json({ error: "reference_workflow is required" });
    }
    if (candidates.length === 0) {
      return res.status(400).json({ error: "candidate_workflow or candidates is required" });
    }

    const cfg = mergeGraphEditEvalConfig(req.body?.graph_edit_eval);
    const lexicalFallback = req.body?.lexical_fallback === true;

    let result = scoreGraphEditBatch(reference, candidates, cfg);
    if (!result.ok && lexicalFallback) {
      result = {
        ok: true,
        scores: candidates.map((c) =>
          scoreGraphEditPair(reference, c, cfg, { lexical_fallback: true })
        ),
        mode: "lexical_fallback"
      };
    }

    if (!result.ok) {
      return res.status(503).json({ error: result.error || "graph_edit unavailable", details: result });
    }

    res.json({
      ok: true,
      config: cfg,
      reference_nodes: result.reference_nodes ?? null,
      scores: result.scores
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

router.post("/api/mwgl/score-with-graph-edit", (req, res) => {
  try {
    const workflow = req.body?.workflow ? normalizeWorkflow(req.body.workflow) : null;
    const reference = req.body?.reference_workflow
      ? normalizeWorkflow(req.body.reference_workflow)
      : null;
    if (!workflow || !reference) {
      return res.status(400).json({
        error: "workflow and reference_workflow are required"
      });
    }

    const evalDataset = Array.isArray(req.body?.eval_dataset) ? req.body.eval_dataset : [];
    const prompt = String(req.body?.prompt || "").trim();
    const weights =
      req.body?.weights && typeof req.body.weights === "object"
        ? { ...DEFAULT_SCORE_WEIGHTS, ...req.body.weights }
        : DEFAULT_SCORE_WEIGHTS;

    const local = scoreWorkflow(workflow, { evalDataset, prompt, weights });
    const cfg = mergeGraphEditEvalConfig(req.body?.graph_edit_eval);
    const lexicalFallback = req.body?.lexical_fallback === true;

    const ge = scoreGraphEditPair(reference, workflow, cfg, { lexical_fallback: lexicalFallback });
    if (!ge.ok) {
      return res.json({
        score: local.score,
        metrics: local.metrics,
        details: { ...local.details, graph_edit_skipped: ge.error },
        graph_edit: null
      });
    }

    const blended = blendScoreWithGraphEdit(local.score, ge.similarity, cfg.weight);
    res.json({
      score: Number(blended.toFixed(6)),
      metrics: {
        ...local.metrics,
        graph_edit_node_f1: ge.node_f1,
        graph_edit_graph_f1: ge.graph_f1,
        graph_edit_similarity: ge.similarity
      },
      details: local.details,
      graph_edit: {
        enabled: true,
        weight: cfg.weight,
        mode: ge.mode,
        fallback: Boolean(ge.fallback),
        local_score: local.score
      }
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

export default router;
