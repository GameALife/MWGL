import express from "express";
import { normalizeWorkflow } from "../js/mwgl.js";
import { buildWorkflowSuggestions } from "../lib/mwgl-workflow-suggestions.mjs";

const router = express.Router();

router.post("/api/mwgl/workflow-suggestions", (req, res) => {
  try {
    const workflow = req.body?.workflow;
    if (!workflow || typeof workflow !== "object") {
      return res.status(400).json({ error: "workflow is required" });
    }
    const prompt = String(req.body?.prompt || "").trim();
    const evalDataset = Array.isArray(req.body?.eval_dataset) ? req.body.eval_dataset : [];
    const normalized = normalizeWorkflow(workflow);
    const result = buildWorkflowSuggestions(normalized, { prompt, evalDataset });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || "workflow-suggestions failed" });
  }
});

export default router;
