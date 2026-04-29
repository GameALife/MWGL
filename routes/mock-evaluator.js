import { Router } from "express";

const router = Router();

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

router.post("/api/mwgl/mock-evaluator", (req, res) => {
  const workflow = req.body?.workflow || {};
  const localMetrics = req.body?.local_metrics || {};
  const evalDataset = Array.isArray(req.body?.eval_dataset) ? req.body.eval_dataset : [];
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];

  const baseSuccess = clamp(Number(localMetrics.task_success || 0), 0, 1);
  const hasFailurePath = nodes.some((n) => n.type === "failure");
  const switchCount = nodes.filter((n) => n.type === "switch").length;
  const parallelCount = nodes.filter((n) => n.type === "parallel").length;
  const edgeLabelCoverage = edges.length > 0 ? edges.filter((e) => String(e.label || "").trim()).length / edges.length : 0;

  let bonus = 0;
  if (hasFailurePath) bonus += 0.03;
  if (switchCount > 0) bonus += 0.02;
  if (parallelCount > 0) bonus += 0.01;
  if (edgeLabelCoverage > 0.3) bonus += 0.02;
  if (evalDataset.length >= 5) bonus += 0.02;

  const taskSuccess = clamp(baseSuccess + bonus, 0, 1);
  const complexity = clamp((nodes.length + 0.4 * edges.length + switchCount) / 70, 0, 1);
  const cost = clamp((nodes.length * 50 + edges.length * 18) / 3200, 0, 1);
  const latency = clamp((nodes.length * 0.075 + parallelCount * 0.35) / 9, 0, 1);
  const score = clamp(1.0 * taskSuccess - 0.15 * cost - 0.1 * latency - 0.2 * complexity, -1, 1);

  res.json({
    score,
    metrics: {
      task_success: taskSuccess,
      cost,
      latency,
      complexity
    },
    meta: {
      evaluator: "mock",
      notes: "For integration test only; replace with real executor-based evaluator."
    }
  });
});

export default router;
