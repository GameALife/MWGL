/**
 * MWGL v3 统一工作流评分（优化 / mock-evaluator 共用）。
 * 结合图结构、评测集条目（含从任务描述推断的约束）与用户 prompt 贴合度。
 */

import {
  normalizeFinalState,
  inferNeedsBranch,
  inferNeedsLoop,
  inferNeedsBranchFromMeta,
  inferNeedsLoopFromMeta,
  flattenOutputVars
} from "../scripts/eval-lang.js";

/** 任务成功三项权重（和为 1） */
export const TASK_SUCCESS_WEIGHTS = {
  structural: 0.3,
  requirements: 0.5,
  prompt_fit: 0.2
};

/** 从 task_success 中扣除的惩罚系数（0.1 步长，和为 0.3） */
export const PENALTY_SCORE_WEIGHTS = {
  cost: 0.1,
  latency: 0.1,
  complexity: 0.1
};

/** 惩罚原始量归一化分母（图越大，cost/latency/complexity 越接近 1） */
export const PENALTY_SCALE = {
  complexityDenom: 50,
  costDenom: 3000,
  costPerNode: 50,
  costPerEdge: 20,
  costPerBranch: 30,
  latencyDenom: 100
};

/** 贴合度：与评测条对齐时的 prompt / 图文案 混合比 */
export const PROMPT_FIT_BLEND = {
  promptVsEval: 0.9,
  workflowVsEval: 0.1
};

export const DEFAULT_SCORE_WEIGHTS = {
  ...TASK_SUCCESS_WEIGHTS,
  ...PENALTY_SCORE_WEIGHTS
};

/**
 * 结构分：仅含 validateWorkflowConstraints 不强制、但能区分合法图质量的维度。
 * 进度/分支 label 合法性等已由硬性检测保证，不再重复计分。
 */
export const STRUCTURAL_SCORE_WEIGHTS = {
  /** 从 start 可达节点占比（允许存在不可达孤岛，硬性检测不罚） */
  reach: 0.25,
  /** 硬性检测只要求「有可达 end」，不强制 success 终态 */
  successEnd: 0.35,
  failureEnd: 0.15,
  /** 无 branch 的简单流仍给少量加分（硬性检测不强制要有分支） */
  noBranch: 0.1,
  /** 含 loop.steps 的 step（硬性检测不强制要有循环） */
  loop: 0.15
};

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function tokenizeText(value) {
  const text = String(value || "").toLowerCase();
  const words = text.match(/[a-z0-9_]+/g) || [];
  const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
  return new Set([...words, ...cjk]);
}

function tokenOverlap(a, b) {
  const ta = tokenizeText(a);
  const tb = tokenizeText(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) {
    if (tb.has(t)) hit += 1;
  }
  return hit / Math.sqrt(ta.size * tb.size);
}

function buildGraph(workflow) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map();
  for (const n of nodes) out.set(n.id, []);
  for (const e of edges) {
    if (out.has(e.from) && byId.has(e.to)) out.get(e.from).push(e);
  }
  return { nodes, edges, byId, out };
}

function findStartId(workflow) {
  return (workflow.nodes || []).find((n) => n.type === "start")?.id || null;
}

function reachableFromStart(workflow) {
  const startId = findStartId(workflow);
  if (!startId) return new Set();
  const { out } = buildGraph(workflow);
  const visited = new Set();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const e of out.get(id) || []) {
      if (!visited.has(e.to)) stack.push(e.to);
    }
  }
  return visited;
}

function canReachTerminal(workflow, fromNodeId) {
  const { byId, out } = buildGraph(workflow);
  if (!byId.has(fromNodeId)) return false;
  const seen = new Set();
  const stack = [fromNodeId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (byId.get(id)?.type === "end") return true;
    for (const e of out.get(id) || []) stack.push(e.to);
  }
  return false;
}

function isSemanticEdgeLabel(label) {
  const text = String(label || "").trim();
  if (!text) return false;
  if (/^\d+$/.test(text)) return false;
  if (/^分支\d*$/i.test(text)) return false;
  return true;
}

function collectWorkflowText(workflow) {
  const parts = [];
  for (const n of workflow.nodes || []) {
    parts.push(String(n.text || ""));
    if (n.loop?.steps) parts.push(JSON.stringify(n.loop.steps));
  }
  for (const e of workflow.edges || []) parts.push(String(e.label || ""));
  return parts.join(" ").toLowerCase();
}

function analyzeWorkflow(workflow) {
  const reachable = reachableFromStart(workflow);
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];
  const reachableNodes = nodes.filter((n) => reachable.has(n.id));
  const terminals = reachableNodes.filter((n) => n.type === "end");
  const hasSuccess = terminals.some((n) => n.outcome === "success");
  const hasFailure = terminals.some((n) => n.outcome === "failure");
  const branches = reachableNodes.filter((n) => n.type === "branch");
  const branchCount = branches.length;
  let validBranchLabels = true;
  const { out, byId } = buildGraph(workflow);
  for (const br of branches) {
    const outs = (out.get(br.id) || []).filter((e) => reachable.has(e.to));
    if (outs.length < 2) {
      validBranchLabels = false;
      continue;
    }
    const labels = outs.map((e) => String(e.label || "").trim());
    if (labels.some((l) => !l) || new Set(labels).size !== labels.length) {
      validBranchLabels = false;
    }
    if (labels.some((l) => !isSemanticEdgeLabel(l))) validBranchLabels = false;
  }
  const hasLoop = nodes.some(
    (n) => n.type === "step" && Array.isArray(n.loop?.steps) && n.loop.steps.length > 0
  );
  const reachableNonTerminal = reachableNodes.filter((n) =>
    ["start", "step", "branch"].includes(n.type)
  );
  const progressOk =
    reachableNonTerminal.length === 0 ||
    reachableNonTerminal.every((n) => canReachTerminal(workflow, n.id));
  const edgeLabels = new Set(
    edges.map((e) => String(e.label || "").trim()).filter(Boolean)
  );
  const textBlob = collectWorkflowText(workflow);
  const nodeCount = nodes.length;
  const edgeCount = edges.length;

  return {
    edgeCount,
    reachable,
    reachableCount: reachable.size,
    nodeCount,
    hasSuccess,
    hasFailure,
    branchCount,
    validBranchLabels,
    hasLoop,
    progressOk,
    edgeLabels,
    textBlob
  };
}

function inferItemSpec(item) {
  const text = [item?.input?.user_text, item?.meta?.task_en].filter(Boolean).join(" ");
  const expected = item?.expected || {};
  const meta = item?.meta || {};
  const mustLabels = Array.isArray(expected.must_have_path_labels)
    ? expected.must_have_path_labels.map((x) => String(x).trim()).filter(Boolean)
    : [];

  const needsBranch =
    typeof expected.needs_branch === "boolean"
      ? expected.needs_branch
      : inferNeedsBranchFromMeta(meta) || inferNeedsBranch(text);
  const needsLoop =
    typeof expected.needs_loop === "boolean"
      ? expected.needs_loop
      : inferNeedsLoopFromMeta(meta) || inferNeedsLoop(text);

  const outputVars = Array.isArray(expected.output_vars)
    ? expected.output_vars.map((v) => String(v).trim()).filter(Boolean)
    : flattenOutputVars(meta.output_var);

  const inputVars = Array.isArray(expected.input_vars)
    ? expected.input_vars.map((v) => String(v).trim()).filter(Boolean)
    : Array.isArray(meta.input_var)
      ? meta.input_var.map((v) => String(v).trim()).filter(Boolean)
      : [];

  return {
    final_state: normalizeFinalState(expected.final_state || "成功"),
    must_have_path_labels: mustLabels,
    needs_branch: needsBranch,
    needs_loop: needsLoop,
    output_vars: outputVars,
    input_vars: inputVars
  };
}

function scoreStructural(ctx) {
  if (ctx.nodeCount === 0) return 0;
  const w = STRUCTURAL_SCORE_WEIGHTS;
  let s = 0;
  const reachRatio = ctx.reachableCount / ctx.nodeCount;
  s += w.reach * clamp(reachRatio, 0, 1);
  if (ctx.hasSuccess) s += w.successEnd;
  if (ctx.hasFailure) s += w.failureEnd;
  if (ctx.branchCount === 0) s += w.noBranch;
  if (ctx.hasLoop) s += w.loop;
  return clamp(s, 0, 1);
}

function scoreEvalItem(ctx, item) {
  const spec = inferItemSpec(item);
  let earned = 0;
  let total = 0;

  total += 1;
  if (spec.final_state === "success" && ctx.hasSuccess) earned += 1;
  else if (spec.final_state === "failure" && ctx.hasFailure) earned += 1;

  for (const label of spec.must_have_path_labels) {
    total += 1;
    if (ctx.edgeLabels.has(label)) earned += 1;
  }

  if (spec.needs_branch) {
    total += 1;
    if (ctx.branchCount >= 1 && ctx.validBranchLabels) earned += 1;
  }

  if (spec.needs_loop) {
    total += 1;
    if (ctx.hasLoop) earned += 1;
  }

  for (const v of spec.output_vars) {
    total += 1;
    const key = String(v).toLowerCase();
    if (key && ctx.textBlob.includes(key)) earned += 1;
  }

  for (const v of spec.input_vars.slice(0, 2)) {
    total += 0.5; // 输入变量权重为输出变量的一半
    const key = String(v).toLowerCase();
    if (key && ctx.textBlob.includes(key)) earned += 0.5;
  }

  return total > 0 ? earned / total : 1;
}

function scoreRequirements(ctx, evalDataset) {
  if (!Array.isArray(evalDataset) || evalDataset.length === 0) return 1;
  let sum = 0;
  for (const item of evalDataset) sum += scoreEvalItem(ctx, item);
  return sum / evalDataset.length;
}

function scorePromptFit(ctx, prompt, evalDataset) {
  const p = String(prompt || "").trim();
  if (!p) return 1;
  const { promptVsEval, workflowVsEval } = PROMPT_FIT_BLEND;
  const workflowText = ctx.textBlob;
  let best = tokenOverlap(p, workflowText);
  for (const item of evalDataset || []) {
    const t = item?.input?.user_text || "";
    best = Math.max(
      best,
      tokenOverlap(p, t) * promptVsEval + tokenOverlap(workflowText, t) * workflowVsEval
    );
  }
  return clamp(best, 0, 1);
}

function scorePenalties(ctx) {
  const scale = PENALTY_SCALE;
  const n = ctx.nodeCount;
  const e = ctx.edgeCount;
  const b = ctx.branchCount;
  const complexity = clamp((n + 0.5 * e + 1.5 * b) / scale.complexityDenom, 0, 1);
  const cost = clamp(
    (n * scale.costPerNode + e * scale.costPerEdge + b * scale.costPerBranch) / scale.costDenom,
    0,
    1
  );
  const latency = clamp(n / scale.latencyDenom, 0, 1);
  return { cost, latency, complexity };
}

/**
 * @param {object} workflow
 * @param {{ evalDataset?: object[], prompt?: string, weights?: object }} options
 */
export function scoreWorkflow(workflow, options = {}) {
  const weights = { ...DEFAULT_SCORE_WEIGHTS, ...(options.weights || {}) };
  const evalDataset = Array.isArray(options.evalDataset) ? options.evalDataset : [];
  const prompt = String(options.prompt || "").trim();
  const ctx = analyzeWorkflow(workflow);

  const structural = scoreStructural(ctx);
  const requirements = scoreRequirements(ctx, evalDataset);
  const prompt_fit = scorePromptFit(ctx, prompt, evalDataset);
  const { cost, latency, complexity } = scorePenalties(ctx);

  const task_success = clamp(
    weights.structural * structural +
      weights.requirements * requirements +
      weights.prompt_fit * prompt_fit,
    0,
    1
  );

  const pw = PENALTY_SCORE_WEIGHTS;
  const penalty =
    (weights.cost ?? pw.cost) * cost +
    (weights.latency ?? pw.latency) * latency +
    (weights.complexity ?? pw.complexity) * complexity;

  const score = clamp(task_success - penalty, 0, 1);

  return {
    metrics: {
      structural: Number(structural.toFixed(6)),
      requirements: Number(requirements.toFixed(6)),
      prompt_fit: Number(prompt_fit.toFixed(6)),
      task_success: Number(task_success.toFixed(6)),
      cost: Number(cost.toFixed(6)),
      latency: Number(latency.toFixed(6)),
      complexity: Number(complexity.toFixed(6))
    },
    score: Number(score.toFixed(6)),
    details: {
      eval_items_used: evalDataset.length,
      has_success_end: ctx.hasSuccess,
      has_failure_end: ctx.hasFailure,
      branch_count: ctx.branchCount,
      has_loop: ctx.hasLoop
    }
  };
}

/** Bandit / MCTS 用：将分数差映射到 [-1, 1] */
export function mutationReward(parentScore, childScore) {
  const delta = Number(childScore) - Number(parentScore);
  return clamp(Math.tanh(delta * 4), -1, 1);
}
