import "../load-env.js";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Router } from "express";
import { normalizeWorkflow, validateWorkflowConstraints } from "../js/mwgl.js";

const router = Router();

/** 优化路径仅允许 Qwen（DashScope 兼容 OpenAI）。不设 DeepSeek / 固定 DashScope URL 兜底；缺省项依赖 QWEN_*。 */
const DEFAULT_QWEN_BASE = String(process.env.QWEN_BASE_URL || "").trim().replace(/\/$/, "");

const DEFAULT_CONFIG = {
  algorithm: "beam",
  iterations: 12,
  beam_width: 4,
  candidates_per_parent: 4,
  mcts_exploration: 1.2,
  mcts_rollout_steps: 2,
  /** 仅 MCTS：为 true 时在首层对每个种子枚举全部内置算子邻域（整图校验通过才挂枝），得到多条并列第一步 */
  mcts_seed_expand_all_operators: false,
  eval_topk: 24,
  retrieval_mode: "faiss",
  max_nodes: 40,
  /** operator_select：仅从代码预生成的合法邻图中选名；llm_generate：小模型直接产出整张合法 MWGL（可一步内配套多改） */
  mutation_mode: "operator_select",
  llm_generate_max_retries: 3,
  /** 为 true 时才调用 llm_scorer；默认 false，仅用本地启发式 + 可选 HTTP evaluator */
  enable_llm_scorer: false,
  weights: {
    task_success: 1.0,
    cost: 0.15,
    latency: 0.1,
    complexity: 0.2
  }
};
const DEFAULT_EVALUATOR = {
  url: "",
  timeout_ms: 3000,
  pass_through_prompt: true
};
const DEFAULT_LLM_MUTATOR = {
  url: "",
  base_url: DEFAULT_QWEN_BASE,
  timeout_ms: 8000,
  pass_through_prompt: true,
  mutation_ratio: 0.85,
  model: process.env.QWEN_MODEL || "qwen-turbo",
  temperature: 0.2,
  max_tokens: 800,
  api_key: ""
};

/** 扩展 / rollout 生成式变异专用（默认可与 mutator 同源；可用更小模型降本） */
const DEFAULT_LLM_EXPAND = {
  url: "",
  base_url: DEFAULT_QWEN_BASE,
  timeout_ms: 12000,
  pass_through_prompt: true,
  model: process.env.MWGL_EXPAND_MODEL || process.env.QWEN_MODEL || "qwen-turbo",
  temperature: 0.35,
  max_tokens: 4096,
  api_key: ""
};

/** 可选：由模型输出综合分（无 HTTP evaluator 或与本地混合参考） */
const DEFAULT_LLM_SCORER = {
  url: "",
  base_url: DEFAULT_QWEN_BASE,
  timeout_ms: 8000,
  pass_through_prompt: true,
  model: process.env.MWGL_SCORER_MODEL || process.env.QWEN_MODEL || "qwen-turbo",
  temperature: 0.1,
  max_tokens: 512,
  api_key: ""
};

const TERMINAL_TYPES = new Set(["success", "failure"]);
const NON_TERMINAL_TYPES = new Set(["start", "wait_user", "switch", "loop_start", "loop_end", "parallel", "case"]);

function deepClone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function mergeConfig(input) {
  const cfg = deepClone(DEFAULT_CONFIG);
  const source = input && typeof input === "object" ? input : {};
  cfg.algorithm = String(source.algorithm || cfg.algorithm);
  cfg.iterations = clamp(Math.floor(safeNumber(source.iterations, cfg.iterations)), 1, 100);
  cfg.beam_width = clamp(Math.floor(safeNumber(source.beam_width, cfg.beam_width)), 1, 20);
  cfg.candidates_per_parent = clamp(Math.floor(safeNumber(source.candidates_per_parent, cfg.candidates_per_parent)), 1, 20);
  cfg.mcts_exploration = clamp(safeNumber(source.mcts_exploration, cfg.mcts_exploration), 0.05, 5);
  cfg.mcts_rollout_steps = clamp(Math.floor(safeNumber(source.mcts_rollout_steps, cfg.mcts_rollout_steps)), 1, 6);
  cfg.mcts_seed_expand_all_operators = Boolean(source.mcts_seed_expand_all_operators);
  cfg.eval_topk = clamp(Math.floor(safeNumber(source.eval_topk, cfg.eval_topk)), 0, 200);
  cfg.retrieval_mode = String(source.retrieval_mode || cfg.retrieval_mode).trim().toLowerCase() === "faiss" ? "faiss" : "token";
  cfg.max_nodes = clamp(Math.floor(safeNumber(source.max_nodes, cfg.max_nodes)), 4, 500);
  const mm = String(source.mutation_mode || cfg.mutation_mode || "")
    .trim()
    .toLowerCase();
  cfg.mutation_mode = mm === "llm_generate" ? "llm_generate" : "operator_select";
  cfg.llm_generate_max_retries = clamp(
    Math.floor(safeNumber(source.llm_generate_max_retries, cfg.llm_generate_max_retries)),
    1,
    8
  );
  cfg.enable_llm_scorer = source.enable_llm_scorer === true;
  cfg.weights.task_success = safeNumber(source.weights?.task_success, cfg.weights.task_success);
  cfg.weights.cost = safeNumber(source.weights?.cost, cfg.weights.cost);
  cfg.weights.latency = safeNumber(source.weights?.latency, cfg.weights.latency);
  cfg.weights.complexity = safeNumber(source.weights?.complexity, cfg.weights.complexity);
  return cfg;
}

function mergeEvaluatorConfig(input) {
  const cfg = deepClone(DEFAULT_EVALUATOR);
  const source = input && typeof input === "object" ? input : {};
  cfg.url = String(source.url || "").trim();
  cfg.timeout_ms = clamp(Math.floor(safeNumber(source.timeout_ms, cfg.timeout_ms)), 200, 30000);
  cfg.pass_through_prompt = source.pass_through_prompt !== false;
  cfg.headers = source.headers && typeof source.headers === "object" ? source.headers : {};
  return cfg;
}

function mergeLlmMutatorConfig(input) {
  const cfg = deepClone(DEFAULT_LLM_MUTATOR);
  const source = input && typeof input === "object" ? input : {};
  cfg.url = String(source.url || "").trim();
  cfg.base_url = String(source.base_url || cfg.base_url).trim();
  cfg.timeout_ms = clamp(Math.floor(safeNumber(source.timeout_ms, cfg.timeout_ms)), 300, 60000);
  cfg.pass_through_prompt = source.pass_through_prompt !== false;
  cfg.mutation_ratio = clamp(safeNumber(source.mutation_ratio, cfg.mutation_ratio), 0, 1);
  cfg.model = String(source.model || cfg.model || "").trim();
  if (!cfg.model) {
    cfg.model = process.env.QWEN_MODEL || DEFAULT_LLM_MUTATOR.model || "qwen-turbo";
  }
  cfg.temperature = clamp(safeNumber(source.temperature, cfg.temperature), 0, 2);
  cfg.max_tokens = clamp(Math.floor(safeNumber(source.max_tokens, cfg.max_tokens)), 64, 8192);
  cfg.api_key = String(source.api_key || process.env.QWEN_API_KEY || "").trim();
  cfg.headers = source.headers && typeof source.headers === "object" ? source.headers : {};
  return cfg;
}

function mergeLlmExpandConfig(input) {
  const cfg = deepClone(DEFAULT_LLM_EXPAND);
  const source = input && typeof input === "object" ? input : {};
  cfg.url = String(source.url || "").trim();
  cfg.base_url = String(source.base_url || cfg.base_url).trim();
  cfg.timeout_ms = clamp(Math.floor(safeNumber(source.timeout_ms, cfg.timeout_ms)), 300, 120000);
  cfg.pass_through_prompt = source.pass_through_prompt !== false;
  cfg.model = String(source.model || cfg.model || "").trim();
  if (!cfg.model) cfg.model = DEFAULT_LLM_EXPAND.model;
  cfg.temperature = clamp(safeNumber(source.temperature, cfg.temperature), 0, 2);
  cfg.max_tokens = clamp(Math.floor(safeNumber(source.max_tokens, cfg.max_tokens)), 256, 8192);
  cfg.api_key = String(source.api_key || process.env.QWEN_API_KEY || "").trim();
  cfg.headers = source.headers && typeof source.headers === "object" ? source.headers : {};
  return cfg;
}

function mergeLlmScorerConfig(input) {
  const cfg = deepClone(DEFAULT_LLM_SCORER);
  const source = input && typeof input === "object" ? input : {};
  cfg.url = String(source.url || "").trim();
  cfg.base_url = String(source.base_url || cfg.base_url).trim();
  cfg.timeout_ms = clamp(Math.floor(safeNumber(source.timeout_ms, cfg.timeout_ms)), 300, 60000);
  cfg.pass_through_prompt = source.pass_through_prompt !== false;
  cfg.model = String(source.model || cfg.model || "").trim();
  if (!cfg.model) cfg.model = DEFAULT_LLM_SCORER.model;
  cfg.temperature = clamp(safeNumber(source.temperature, cfg.temperature), 0, 2);
  cfg.max_tokens = clamp(Math.floor(safeNumber(source.max_tokens, cfg.max_tokens)), 64, 2048);
  cfg.api_key = String(source.api_key || process.env.QWEN_API_KEY || "").trim();
  cfg.headers = source.headers && typeof source.headers === "object" ? source.headers : {};
  return cfg;
}

function tokenizeText(value) {
  const text = String(value || "").toLowerCase();
  const words = text.match(/[a-z0-9_]+/g) || [];
  const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
  return new Set([...words, ...cjk]);
}

function scoreEvalItem(item, promptTokens) {
  const text = String(item?.input?.user_text || "");
  const itemTokens = tokenizeText(text);
  if (itemTokens.size === 0 || promptTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of promptTokens) {
    if (itemTokens.has(t)) overlap += 1;
  }
  return overlap / Math.sqrt(itemTokens.size);
}

function selectRelevantEvalDatasetToken(evalDataset, prompt, evalTopk) {
  if (!Array.isArray(evalDataset) || evalDataset.length === 0) return [];
  if (!evalTopk || evalTopk >= evalDataset.length) return evalDataset;
  const promptTokens = tokenizeText(prompt);
  if (promptTokens.size === 0) return evalDataset.slice(0, evalTopk);
  return evalDataset
    .map((item, idx) => ({ item, idx, score: scoreEvalItem(item, promptTokens) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx))
    .slice(0, evalTopk)
    .map((x) => x.item);
}

function selectRelevantEvalDatasetFaiss(evalDataset, prompt, evalTopk) {
  if (!Array.isArray(evalDataset) || evalDataset.length === 0) return [];
  if (!evalTopk || evalTopk >= evalDataset.length) return evalDataset;
  let tempDir = null;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwgl-faiss-"));
    const datasetPath = path.join(tempDir, "eval.jsonl");
    const lines = evalDataset.map((item, idx) => {
      const id = String(item?.id || `eval_${idx + 1}`);
      return JSON.stringify({ ...item, id });
    });
    fs.writeFileSync(datasetPath, lines.join("\n") + "\n", "utf8");
    const scriptPath = path.join(process.cwd(), "scripts", "faiss-select.py");
    const pyBin = process.env.MWGL_PYTHON_BIN || "python3";
    const out = execFileSync(
      pyBin,
      [scriptPath, "--dataset", datasetPath, "--topk", String(evalTopk), "--prompt", String(prompt || "")],
      { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] }
    );
    const payload = JSON.parse(out);
    const picked = new Set(Array.isArray(payload?.selected_ids) ? payload.selected_ids.map((x) => String(x)) : []);
    if (picked.size === 0) return selectRelevantEvalDatasetToken(evalDataset, prompt, evalTopk);
    return evalDataset.filter((x, idx) => picked.has(String(x?.id || `eval_${idx + 1}`))).slice(0, evalTopk);
  } catch (_error) {
    return selectRelevantEvalDatasetToken(evalDataset, prompt, evalTopk);
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function selectRelevantEvalDataset(evalDataset, prompt, config) {
  if (config.retrieval_mode === "faiss") {
    return selectRelevantEvalDatasetFaiss(evalDataset, prompt, config.eval_topk);
  }
  return selectRelevantEvalDatasetToken(evalDataset, prompt, config.eval_topk);
}

function buildGraph(workflow) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map();
  for (const node of nodes) out.set(node.id, []);
  for (const edge of edges) {
    if (out.has(edge.from) && byId.has(edge.to)) {
      out.get(edge.from).push(edge);
    }
  }
  return { byId, out };
}

function findStartNode(workflow) {
  return (workflow.nodes || []).find((n) => n.type === "start") || null;
}

function reachableFromStart(workflow) {
  const start = findStartNode(workflow);
  if (!start) return new Set();
  const { out } = buildGraph(workflow);
  const visited = new Set();
  const stack = [start.id];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of out.get(id) || []) {
      if (!visited.has(edge.to)) stack.push(edge.to);
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
    const node = byId.get(id);
    if (node && TERMINAL_TYPES.has(node.type)) return true;
    for (const edge of out.get(id) || []) stack.push(edge.to);
  }
  return false;
}

function evaluateTaskSuccess(workflow, evalDataset) {
  const reachable = reachableFromStart(workflow);
  const terminals = (workflow.nodes || []).filter((n) => TERMINAL_TYPES.has(n.type) && reachable.has(n.id));
  const hasSuccess = terminals.some((n) => n.type === "success");
  const hasFailure = terminals.some((n) => n.type === "failure");
  let structural = 0;
  if (reachable.size > 0) structural += 0.35;
  if (hasSuccess) structural += 0.35;
  if (hasFailure) structural += 0.15;

  const reachableNonTerminal = (workflow.nodes || []).filter(
    (n) => NON_TERMINAL_TYPES.has(n.type) && reachable.has(n.id)
  );
  const progressOk = reachableNonTerminal.every((n) => canReachTerminal(workflow, n.id));
  if (progressOk) structural += 0.15;
  structural = clamp(structural, 0, 1);

  if (!Array.isArray(evalDataset) || evalDataset.length === 0) {
    return structural;
  }

  let pass = 0;
  for (const item of evalDataset) {
    const expected = item?.expected || {};
    const desiredFinal = String(expected.final_state || "").trim();
    const labels = Array.isArray(expected.must_have_path_labels) ? expected.must_have_path_labels : [];
    let ok = true;
    if (desiredFinal === "success" && !hasSuccess) ok = false;
    if (desiredFinal === "failure" && !hasFailure) ok = false;
    if (labels.length > 0) {
      const allLabels = new Set((workflow.edges || []).map((e) => String(e.label || "").trim()).filter(Boolean));
      if (!labels.every((x) => allLabels.has(String(x).trim()))) ok = false;
    }
    if (ok) pass += 1;
  }
  const datasetScore = pass / evalDataset.length;
  return clamp(0.5 * structural + 0.5 * datasetScore, 0, 1);
}

function computeMetrics(workflow, evalDataset) {
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];
  const switches = nodes.filter((n) => n.type === "switch").length;
  const parallels = nodes.filter((n) => n.type === "parallel").length;
  const loops = nodes.filter((n) => n.type === "loop_start" || n.type === "loop_end").length;
  const complexityRaw = nodes.length + 0.5 * edges.length + 2 * switches + 1.5 * parallels + loops;
  const complexity = clamp(complexityRaw / 60, 0, 1);
  const costRaw = nodes.length * 55 + edges.length * 20 + switches * 30 + parallels * 20;
  const cost = clamp(costRaw / 3000, 0, 1);
  const latencyRaw = nodes.length * 0.08 + parallels * 0.35;
  const latency = clamp(latencyRaw / 8, 0, 1);
  const taskSuccess = evaluateTaskSuccess(workflow, evalDataset);
  return { task_success: taskSuccess, cost, latency, complexity };
}

function computeScore(metrics, weights) {
  return (
    weights.task_success * metrics.task_success -
    weights.cost * metrics.cost -
    weights.latency * metrics.latency -
    weights.complexity * metrics.complexity
  );
}

function nextNodeId(workflow, hint = "case") {
  const ids = new Set((workflow.nodes || []).map((n) => String(n.id)));
  let i = 1;
  while (ids.has(`n_${hint}_${i}`)) i += 1;
  return `n_${hint}_${i}`;
}

function nextEdgeId(workflow, hint = "flow") {
  const ids = new Set((workflow.edges || []).map((e) => String(e.id)));
  let i = 1;
  while (ids.has(`e_${hint}_${i}`)) i += 1;
  return `e_${hint}_${i}`;
}

function randomItem(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function pickCaseLikeNode(workflow) {
  const candidates = (workflow.nodes || []).filter((n) => n.type === "case" || n.type === "wait_user");
  return randomItem(candidates);
}

function opRenameTextForSemantics(workflow) {
  const node = randomItem((workflow.nodes || []).filter((n) => n.type === "case"));
  if (!node) return null;
  const mutated = deepClone(workflow);
  const target = mutated.nodes.find((n) => n.id === node.id);
  if (!target) return null;
  if (!target.text || /^新动作|未命名/.test(target.text)) {
    target.text = "执行业务动作";
  } else if (!target.text.includes("（优化）")) {
    target.text = `${target.text}（优化）`;
  } else {
    target.text = target.text.replace("（优化）", "");
  }
  return { workflow: mutated, op: "rename_text_for_semantics" };
}

function opChangeEdgeLabel(workflow) {
  const candidates = (workflow.edges || []).filter((e) => typeof e.label === "string");
  const edge = randomItem(candidates);
  if (!edge) return null;
  const pool = ["已认证", "未认证", "超时", "重试上限", "库存不足", "金额>1000"];
  const mutated = deepClone(workflow);
  const target = mutated.edges.find((e) => e.id === edge.id);
  if (!target) return null;
  target.label = randomItem(pool) || "条件满足";
  return { workflow: mutated, op: "change_edge_label" };
}

function opAddFailurePath(workflow) {
  const from = pickCaseLikeNode(workflow);
  if (!from) return null;
  const mutated = deepClone(workflow);
  const failure = randomItem(mutated.nodes.filter((n) => n.type === "failure"));
  let failureNode = failure;
  if (!failureNode) {
    if (mutated.nodes.length >= 200) return null;
    failureNode = {
      id: nextNodeId(mutated, "failure"),
      type: "failure",
      text: "失败结束",
      x: 880,
      y: 460
    };
    mutated.nodes.push(failureNode);
  }
  mutated.edges.push({
    id: nextEdgeId(mutated, "failure"),
    from: from.id,
    to: failureNode.id,
    label: "异常"
  });
  return { workflow: mutated, op: "add_failure_path" };
}

function opPruneRedundantCase(workflow) {
  const mutated = deepClone(workflow);
  const { out } = buildGraph(mutated);
  const candidates = mutated.nodes.filter((n) => n.type === "case" && (out.get(n.id) || []).length === 1);
  const target = randomItem(candidates);
  if (!target) return null;
  const inbound = mutated.edges.filter((e) => e.to === target.id);
  const outbound = mutated.edges.find((e) => e.from === target.id);
  if (!outbound) return null;
  for (const inEdge of inbound) {
    mutated.edges.push({
      id: nextEdgeId(mutated, "bypass"),
      from: inEdge.from,
      to: outbound.to,
      label: inEdge.label || ""
    });
  }
  mutated.edges = mutated.edges.filter((e) => e.from !== target.id && e.to !== target.id);
  mutated.nodes = mutated.nodes.filter((n) => n.id !== target.id);
  return { workflow: mutated, op: "prune_redundant_case" };
}

function opAddSwitchAfterNode(workflow) {
  const base = pickCaseLikeNode(workflow);
  if (!base) return null;
  const mutated = deepClone(workflow);
  const baseOut = mutated.edges.filter((e) => e.from === base.id);
  if (baseOut.length === 0) return null;
  const original = baseOut[0];
  mutated.edges = mutated.edges.filter((e) => e.id !== original.id);
  const switchNodeId = nextNodeId(mutated, "switch");
  const caseNodeId = nextNodeId(
    { ...mutated, nodes: [...mutated.nodes, { id: switchNodeId }] },
    "case"
  );
  mutated.nodes.push(
    { id: switchNodeId, type: "switch", text: "条件判断", x: 540, y: 250 },
    { id: caseNodeId, type: "case", text: "补充处理", x: 700, y: 320 }
  );
  mutated.edges.push(
    { id: nextEdgeId(mutated, "sw_enter"), from: base.id, to: switchNodeId, label: "" },
    { id: nextEdgeId(mutated, "sw_yes"), from: switchNodeId, to: original.to, label: "满足条件" },
    { id: nextEdgeId(mutated, "sw_no"), from: switchNodeId, to: caseNodeId, label: "不满足条件" },
    { id: nextEdgeId(mutated, "sw_join"), from: caseNodeId, to: original.to, label: "" }
  );
  return { workflow: mutated, op: "add_switch_after_node" };
}

function opParallelizeCases(workflow) {
  const mutated = deepClone(workflow);
  const start = findStartNode(mutated);
  if (!start) return null;
  const cases = mutated.nodes.filter((n) => n.type === "case").slice(0, 2);
  if (cases.length < 2) return null;
  const parallelId = nextNodeId(mutated, "parallel");
  mutated.nodes.push({ id: parallelId, type: "parallel", text: "并行处理", x: 360, y: 240 });
  const startEdge = mutated.edges.find((e) => e.from === start.id);
  if (!startEdge) return null;
  mutated.edges = mutated.edges.filter((e) => e.id !== startEdge.id);
  mutated.edges.push(
    { id: nextEdgeId(mutated, "p_start"), from: start.id, to: parallelId, label: "" },
    { id: nextEdgeId(mutated, "p_a"), from: parallelId, to: cases[0].id, label: "并行分支A" },
    { id: nextEdgeId(mutated, "p_b"), from: parallelId, to: cases[1].id, label: "并行分支B" }
  );
  return { workflow: mutated, op: "parallelize_cases" };
}

function opMergeParallelBranches(workflow) {
  const mutated = deepClone(workflow);
  const parallel = randomItem(mutated.nodes.filter((n) => n.type === "parallel"));
  if (!parallel) return null;
  const targets = mutated.edges.filter((e) => e.from === parallel.id).map((e) => e.to);
  if (targets.length < 2) return null;
  const joinCandidate = randomItem(mutated.nodes.filter((n) => n.type === "case" || n.type === "success"));
  if (!joinCandidate) return null;
  for (const t of targets) {
    mutated.edges.push({
      id: nextEdgeId(mutated, "join"),
      from: t,
      to: joinCandidate.id,
      label: ""
    });
  }
  return { workflow: mutated, op: "merge_parallel_branches" };
}

function opInsertRetryLoop(workflow) {
  const base = pickCaseLikeNode(workflow);
  if (!base) return null;
  const mutated = deepClone(workflow);
  const outEdge = mutated.edges.find((e) => e.from === base.id);
  if (!outEdge) return null;
  mutated.edges = mutated.edges.filter((e) => e.id !== outEdge.id);
  const loopStartId = nextNodeId(mutated, "loop_start");
  const loopEndId = nextNodeId({ ...mutated, nodes: [...mutated.nodes, { id: loopStartId }] }, "loop_end");
  mutated.nodes.push(
    { id: loopStartId, type: "loop_start", text: "重试循环开始", x: 520, y: 220 },
    { id: loopEndId, type: "loop_end", text: "重试循环结束", x: 760, y: 220 }
  );
  mutated.edges.push(
    { id: nextEdgeId(mutated, "loop_enter"), from: base.id, to: loopStartId, label: "" },
    { id: nextEdgeId(mutated, "loop_body"), from: loopStartId, to: loopEndId, label: "" },
    { id: nextEdgeId(mutated, "loop_exit"), from: loopEndId, to: outEdge.to, label: "退出循环" }
  );
  return { workflow: mutated, op: "insert_retry_loop" };
}

const OPERATORS = [
  opAddSwitchAfterNode,
  opChangeEdgeLabel,
  opInsertRetryLoop,
  opParallelizeCases,
  opMergeParallelBranches,
  opAddFailurePath,
  opPruneRedundantCase,
  opRenameTextForSemantics
];

/** 与内置算子 id 一致，供生成模型作「意图白名单」提示；无前置可用算子时退回全集 */
const OPERATOR_HINT_IDS = [
  "add_switch_after_node",
  "change_edge_label",
  "insert_retry_loop",
  "parallelize_cases",
  "merge_parallel_branches",
  "add_failure_path",
  "prune_redundant_case",
  "rename_text_for_semantics"
];

/** 供 user 消息算子字段释义（与代码内置 OPERATORS 一致） */
const OPERATOR_SEMANTICS_ZH = {
  add_switch_after_node: "在合适节点后插入 switch，用出边 label 承载互斥条件",
  change_edge_label: "修改边 label，常用于细化 switch 分支条件或其它转移语义",
  insert_retry_loop: "在 case 类节点后插入重试循环（loop_start→loop_end 结构）",
  parallelize_cases: "将若干并列 case 改为 parallel 并行语义",
  merge_parallel_branches: "合并并行分支的汇聚结构",
  add_failure_path: "补充 failure 终态路径，明确非成功业务结局",
  prune_redundant_case: "删除或合并冗余 case 节点/边",
  rename_text_for_semantics: "调整节点 text，使业务语义可读（须符合 failure 等非泛化文案要求）"
};

/**
 * 与 `validateWorkflowConstraints` + normalize 行为对齐的合法改写要点（小模型须按此自检）。
 * normalize 会过滤部分非法边以保持 DAG，仍应尽量一次性产出可通过校验的图。
 */
const MWGL_V2_HARD_RULES_ZH = [
  "【结构】全图为有向无环图（DAG）：禁止自环；边的 from/to 必须引用已存在节点 id；success/failure 禁止任何出边。",
  "【入口】必须且仅能有一个 start；start 无入边；start 至少一条出边。",
  "【终态】至少存在一个从 start 可达的 success 或 failure；从 start 可达的每个非终态节点都必须能到达某个终态（无执行死路）。",
  "【分支】switch 至少一条出边；每条出边 label 非空、在同一 switch 下不重复；label 须为可判定业务语义（禁止纯数字、禁止「分支N」类占位）。",
  "【并行】parallel 至少两条出边。",
  "【循环】loop_start 有且仅有 1 条出边（进入循环体）；从该 loop_start 沿边必须能到达某个 loop_end；loop_end 至少一条出边；每个 loop_end 须能从某个 loop_start 到达（成对）。",
  "【动作】case、wait_user 每个节点最多一条出边。",
  "【失败节点】failure 的 text 不得为泛化词（如单独「失败」「failure」）；须写明具体失败语义（如任务未达成-超时、失败结局-生命值归零）。可选 failure_kind：game_lose | goal_not_met | precondition_not_met | risk_blocked。",
  "【规模】节点数不得超过用户给出的 max_nodes。"
].join("\n");

/** operator_select：小模型仅从预生成合法邻域中选名 */
const OPERATOR_SELECT_SYSTEM_ZH = [
  "你是 MWGL 变异算子选择器。用户消息为 JSON：含 workflow、available_operators（字符串 id 列表）、prompt、max_nodes 等。",
  "你必须且只能从 available_operators 中选择一个算子 id 执行改写；不得发明新 id。若当前列表均无法安全改进优化目标，则拒绝。",
  "只输出一个 JSON 对象，两种形态之一：",
  '{"decision":"choose","op":"<须等于列表中某项>"} 或 {"decision":"reject","reason":"<简短原因>"}。',
  "禁止 markdown、禁止代码围栏、禁止 JSON 以外的文字。"
].join("\n");

function listRelevantOperatorHints(parentWorkflow, maxNodes) {
  const hints = [];
  for (const opFn of OPERATORS) {
    const candidate = opFn(parentWorkflow);
    if (!candidate) continue;
    if ((candidate.workflow.nodes || []).length > maxNodes) continue;
    hints.push(candidate.op);
  }
  return hints;
}

const LLM_GENERATE_SYSTEM = [
  "你是 MWGL v2 工作流「合法改写」专用小模型。用户消息为 JSON：含 phase（generate 或 repair）、prompt、workflow、max_nodes、relevant_operators；repair 时另有 previous_json、validation_errors。",
  "",
  "【任务】output 必须是替换后的**完整**工作流对象（整图替换，不是 patch）。可在一步内做多处配套修改（如同时调整 switch 分支与边标签）。phase=repair 时：必须在语义保持的前提下**逐项消除** validation_errors 中的全部校验错误后再输出。",
  "",
  "【输出契约 — 违反即视为失败】",
  "- 你的回复中**有效内容仅为一个 JSON 对象**（表示 MWGL v2 工作流），首字符为「{」，末字符为「}」。",
  "- **禁止** markdown、**禁止** ``` 代码围栏、**禁止** JSON 前后的说明/标题/注释/「以下是」等任何额外文本。",
  "- **禁止** 外层再包一层：顶层字段必须是 mwgl_version、rule_id、rule_name、nodes、edges（勿仅用 workflow 键包裹内层对象）。",
  "",
  MWGL_V2_HARD_RULES_ZH,
  "",
  "【字段形状】顶层：mwgl_version（数字 2）、rule_id、rule_name、nodes、edges。nodes[]：id,type,text,x,y（数值坐标）；type=failure 时可含 failure_kind。edges[]：id,from,to,label（字符串）。type 枚举：start,wait_user,switch,loop_start,loop_end,parallel,case,success,failure。",
  "",
  "【relevant_operators / operator_hints】用户 JSON 中含 relevant_operators（id 列表）及 operator_hints（id+中文释义）；与业务 prompt 冲突时以可通过服务端校验（与实现 validateWorkflowConstraints 一致）为准。",
  "",
  "【自检】输出前在内心核对上述硬性规则；repair 阶段须对照 validation_errors 直到校验可通过。"
].join("\n");

function stripMarkdownFence(text) {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function validateWorkflowJsonText(raw) {
  try {
    const parsed = JSON.parse(stripMarkdownFence(raw));
    const normalized = normalizeWorkflow(parsed);
    const result = validateWorkflowConstraints(normalized);
    return { ok: result.ok, errors: result.errors || [], normalized };
  } catch (error) {
    return {
      ok: false,
      errors: [`JSON 解析或结构错误：${error.message}`],
      normalized: null
    };
  }
}

function resolveExpandClient(context) {
  const ex = context?.llmExpand;
  if (ex?.url || (ex?.base_url && ex?.api_key && ex?.model)) return ex;
  const m = context?.llmMutator;
  if (m?.url || (m?.base_url && m?.api_key && m?.model)) return m;
  return null;
}

function llmClientEnabled(client) {
  return Boolean(client?.url || (client?.base_url && client?.api_key && client?.model));
}

/** 请求未带完整客户端字段时，仅用 QWEN_* 补全（无 DeepSeek / 无固定 URL 兜底） */
function mergeQwenFromEnvDefaults(client) {
  if (llmClientEnabled(client)) return client;
  const apiKey = process.env.QWEN_API_KEY || "";
  if (!String(apiKey).trim()) return client;
  const baseRaw =
    (client.base_url && String(client.base_url).trim()) || process.env.QWEN_BASE_URL || "";
  const modelRaw =
    (client.model && String(client.model).trim()) || process.env.QWEN_MODEL || "qwen-turbo";
  return {
    ...client,
    api_key: (client.api_key && String(client.api_key).trim()) || String(apiKey).trim(),
    base_url: String(baseRaw || "").replace(/\/$/, ""),
    model: String(modelRaw || "").trim() || "qwen-turbo"
  };
}

/** 合并后再强制铺齐 api_key / base_url / model，仅来源 QWEN_* 或请求体显式字段 */
function finalizeQwenCredentials(client) {
  const apiKey = String(client.api_key || process.env.QWEN_API_KEY || "").trim();
  const baseUrl = String(client.base_url || process.env.QWEN_BASE_URL || "").trim().replace(/\/$/, "");
  const model = String(client.model || process.env.QWEN_MODEL || "qwen-turbo").trim();
  return {
    ...client,
    api_key: apiKey,
    base_url: baseUrl,
    model
  };
}

/** 禁止优化链路指向 DeepSeek（环境兜底已关闭，请求体亦不允许） */
function endpointLooksLikeDeepSeek(urlStr) {
  return String(urlStr || "")
    .toLowerCase()
    .includes("deepseek");
}

function mutatorDiagnostics(llmMutator) {
  const url = Boolean(llmMutator?.url && String(llmMutator.url).trim());
  const base = Boolean(llmMutator?.base_url && String(llmMutator.base_url).trim());
  const key = Boolean(llmMutator?.api_key && String(llmMutator.api_key).trim());
  const model = Boolean(llmMutator?.model && String(llmMutator.model).trim());
  const envHint = {
    has_QWEN_API_KEY: Boolean(process.env.QWEN_API_KEY && String(process.env.QWEN_API_KEY).trim()),
    has_QWEN_BASE_URL: Boolean(process.env.QWEN_BASE_URL && String(process.env.QWEN_BASE_URL).trim()),
    has_QWEN_MODEL: Boolean(process.env.QWEN_MODEL && String(process.env.QWEN_MODEL).trim())
  };
  return { url, base_url: base, api_key: key, model, envHint };
}

async function postChatCompletion(clientCfg, messages, options = {}) {
  const { jsonObject = false } = options;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), clientCfg.timeout_ms);
  const apiUrl = `${String(clientCfg.base_url || "").replace(/\/$/, "")}/chat/completions`;
  try {
    const body = {
      model: clientCfg.model,
      temperature: clientCfg.temperature,
      max_tokens: clientCfg.max_tokens,
      messages,
      ...(jsonObject ? { response_format: { type: "json_object" } } : {})
    };
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${clientCfg.api_key}`,
        ...clientCfg.headers
      },
      signal: ctrl.signal,
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Qwen chat/completions：HTTP ${response.status} ${text.slice(0, 520)}`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Qwen chat/completions：响应非 JSON ${text.slice(0, 360)}`);
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`Qwen chat/completions：缺少 choices[0].message.content ${text.slice(0, 360)}`);
    }
    return content;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Qwen chat/completions")) throw e;
    const hint = e?.name === "AbortError" ? "请求超时（Abort）" : e?.message || String(e);
    throw new Error(`Qwen chat/completions：${hint}`);
  } finally {
    clearTimeout(timer);
  }
}

function buildGenerateUserPayload(context, expandCfg, parentWorkflow, maxNodes, relevantHints, phase, repair) {
  const ops = relevantHints.length > 0 ? relevantHints : OPERATOR_HINT_IDS;
  const base = {
    phase,
    prompt: clientCfgPassPrompt(context, expandCfg),
    workflow: parentWorkflow,
    max_nodes: maxNodes,
    relevant_operators: ops,
    operator_hints: ops.map((id) => ({
      id,
      purpose_zh: OPERATOR_SEMANTICS_ZH[id] || ""
    })),
    output_requirement_zh:
      "模型回复正文只能是单个 MWGL v2 工作流 JSON 对象（mwgl_version,nodes,edges 等），禁止 markdown、禁止代码围栏、禁止任何额外说明。",
    validation_implies:
      "服务端使用与本仓库 mwgl-v2.js 中 validateWorkflowConstraints 相同的规则校验你的输出；repair 阶段必须消除列出的全部 validation_errors。"
  };
  if (phase === "repair" && repair) {
    base.previous_json = repair.previousJson;
    base.validation_errors = repair.errorsText;
    if (repair.instruction) base.instruction = repair.instruction;
  }
  return JSON.stringify(base);
}

function clientCfgPassPrompt(context, expandCfg) {
  const pass = expandCfg?.pass_through_prompt !== false;
  return pass ? String(context?.prompt || "").trim() : "";
}

async function mutateWorkflowViaLlmGenerate(parentWorkflow, maxNodes, context) {
  let expandCfg = resolveExpandClient(context);
  if (!expandCfg || !llmClientEnabled(expandCfg)) return null;
  if (safeNumber(expandCfg.max_tokens, 0) < 2048) {
    expandCfg = { ...expandCfg, max_tokens: Math.min(8192, 2048) };
  }

  let relevantHints = listRelevantOperatorHints(parentWorkflow, maxNodes);
  if (relevantHints.length === 0) relevantHints = [...OPERATOR_HINT_IDS];

  const maxRounds = clamp(
    Math.floor(safeNumber(context?.llmGenerateMaxRetries, 3)),
    1,
    8
  );

  async function runOnce(userBodyStr) {
    if (expandCfg.url) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), expandCfg.timeout_ms);
      try {
        const response = await fetch(expandCfg.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...expandCfg.headers
          },
          signal: ctrl.signal,
          body: userBodyStr
        });
        const rawText = await response.text();
        if (!response.ok) {
          throw new Error(`llm_expand.url：HTTP ${response.status} ${rawText.slice(0, 520)}`);
        }
        let payload;
        try {
          payload = JSON.parse(rawText);
        } catch {
          throw new Error(`llm_expand.url：响应非 JSON ${rawText.slice(0, 360)}`);
        }
        if (typeof payload?.content === "string") return payload.content;
        if (typeof payload?.workflow === "object") return JSON.stringify(payload.workflow);
        throw new Error(`llm_expand.url：期望 content 字符串或 workflow 对象`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("llm_expand.url")) throw e;
        throw new Error(`llm_expand.url：${e?.message || String(e)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    const messages = [
      { role: "system", content: LLM_GENERATE_SYSTEM },
      {
        role: "user",
        content: userBodyStr
      }
    ];
    return postChatCompletion(expandCfg, messages, { jsonObject: true });
  }

  let userContent = buildGenerateUserPayload(
    context,
    expandCfg,
    parentWorkflow,
    maxNodes,
    relevantHints,
    "generate",
    null
  );
  let raw = await runOnce(userContent);
  let checked = raw ? validateWorkflowJsonText(raw) : { ok: false, errors: ["empty_response"], normalized: null };

  for (let round = 1; round < maxRounds && !checked.ok; round += 1) {
    const errLines = (checked.errors || []).map((e, i) => `${i + 1}) ${e}`).join("\n");
    const repairBody = buildGenerateUserPayload(context, expandCfg, parentWorkflow, maxNodes, relevantHints, "repair", {
      previousJson: stripMarkdownFence(raw || "{}"),
      errorsText: errLines,
      instruction: `第 ${round + 1}/${maxRounds} 次修复。必须逐项消除本请求中的 validation_errors；输出仍为完整工作流 JSON，且回复正文只能包含该 JSON（无 markdown、无解释）。`
    });
    raw = await runOnce(repairBody);
    checked = raw ? validateWorkflowJsonText(raw) : { ok: false, errors: ["empty_response"], normalized: null };
  }

  if (!checked.ok || !checked.normalized) return null;
  if ((checked.normalized.nodes || []).length > maxNodes) return null;
  return { workflow: checked.normalized, op: "llm_generate" };
}

/** 仅按「能不能执行这条算子」与节点上限筛选；不做整图硬校验（校验留在 beam/MCTS 扩展阶段） */
function listValidOperatorChoices(parentWorkflow, maxNodes) {
  const validChoices = [];
  for (const opFn of OPERATORS) {
    const candidate = opFn(parentWorkflow);
    if (!candidate) continue;
    if ((candidate.workflow.nodes || []).length > maxNodes) continue;
    const normalized = normalizeWorkflow(candidate.workflow);
    validChoices.push({
      op: candidate.op,
      workflow: normalized
    });
  }
  return validChoices;
}

/** MCTS 种子层并列分枝：八种算子各试一遍，仅保留通过整图校验且不重复的邻图 */
function listAllValidatedOperatorBranches(parentWorkflow, maxNodes) {
  const out = [];
  for (const opFn of OPERATORS) {
    const candidate = opFn(parentWorkflow);
    if (!candidate) continue;
    if ((candidate.workflow.nodes || []).length > maxNodes) continue;
    const normalized = normalizeWorkflow(candidate.workflow);
    const check = validateWorkflowConstraints(normalized);
    if (!check.ok) continue;
    out.push({
      op: candidate.op,
      workflow: normalized
    });
  }
  return out;
}

async function mutateWorkflowViaLlm(parentWorkflow, maxNodes, context) {
  const llmMutator = context?.llmMutator;
  if (!llmMutator?.url && !(llmMutator?.base_url && llmMutator?.api_key && llmMutator?.model)) return null;
  const validChoices = listValidOperatorChoices(parentWorkflow, maxNodes);
  if (validChoices.length === 0) {
    return { rejected: true, reason: "no_legal_operator_available" };
  }
  const availableOps = validChoices.map((x) => x.op);
  const validChoiceByOp = new Map(validChoices.map((x) => [x.op, x]));
  let timer = null;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), llmMutator.timeout_ms);
    let response;
    if (llmMutator.url) {
      response = await fetch(llmMutator.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...llmMutator.headers
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          prompt: llmMutator.pass_through_prompt ? context?.prompt || "" : "",
          workflow: parentWorkflow,
          max_nodes: maxNodes,
          available_operators: availableOps,
          model: llmMutator.model || undefined,
          temperature: llmMutator.temperature,
          max_tokens: llmMutator.max_tokens,
          hint:
            "仅输出 JSON：{\"decision\":\"choose\",\"op\":\"<available_operators 中之一>\"} 或 {\"decision\":\"reject\",\"reason\":\"...\"}；禁止其它文字。"
        })
      });
    } else {
      const apiUrl = `${llmMutator.base_url.replace(/\/$/, "")}/chat/completions`;
      response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llmMutator.api_key}`,
          ...llmMutator.headers
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: llmMutator.model,
          temperature: llmMutator.temperature,
          max_tokens: llmMutator.max_tokens,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: OPERATOR_SELECT_SYSTEM_ZH
            },
            {
              role: "user",
              content: JSON.stringify({
                prompt: llmMutator.pass_through_prompt ? context?.prompt || "" : "",
                workflow: parentWorkflow,
                max_nodes: maxNodes,
                available_operators: availableOps,
                operator_meanings: availableOps.map((id) => ({
                  id,
                  purpose_zh: OPERATOR_SEMANTICS_ZH[id] || ""
                })),
                output_requirement_zh: "仅输出一个 JSON 对象，禁止 markdown 与任何附加说明。"
              })
            }
          ]
        })
      });
    }
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`Qwen chat/completions（operator_select）：HTTP ${response.status} ${rawText.slice(0, 520)}`);
    }
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new Error(`Qwen chat/completions（operator_select）：响应非 JSON ${rawText.slice(0, 360)}`);
    }
    if (!llmMutator.url) {
      const content = payload?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(`Qwen chat/completions（operator_select）：缺少 message.content ${rawText.slice(0, 360)}`);
      }
      try {
        payload = JSON.parse(content);
      } catch (e) {
        throw new Error(`Qwen chat/completions（operator_select）：content 非合法 JSON：${e.message || String(e)}`);
      }
    }
    const decision = String(payload?.decision || "").trim().toLowerCase();
    if (decision === "reject") {
      return { rejected: true, reason: String(payload?.reason || "llm_rejected") };
    }
    const opName = String(payload?.op || "").trim();
    const picked = validChoiceByOp.get(opName);
    if (!picked) return null;
    return { workflow: picked.workflow, op: picked.op };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Qwen chat/completions")) throw error;
    throw new Error(`Qwen chat/completions（operator_select）：${error?.message || String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mutateWorkflow(parentWorkflow, maxNodes, context) {
  const mode = context?.mutationMode || "operator_select";
  const mutator = context?.llmMutator;
  const hasMutator = llmClientEnabled(mutator);
  const expandResolved = resolveExpandClient(context);
  const hasExpandClient = llmClientEnabled(expandResolved);

  if (mode === "llm_generate") {
    if (!hasExpandClient && !hasMutator) return null;
    const generated = await mutateWorkflowViaLlmGenerate(parentWorkflow, maxNodes, context);
    return generated || null;
  }

  if (!hasMutator) return null;
  const llmCandidate = await mutateWorkflowViaLlm(parentWorkflow, maxNodes, context);
  if (llmCandidate && !llmCandidate.rejected) return llmCandidate;
  return null;
}

function computeLocalEvaluation(workflow, evalDataset, configWeights) {
  const metrics = computeMetrics(workflow, evalDataset);
  const score = computeScore(metrics, configWeights);
  return { workflow, metrics, score };
}

async function scoreViaLlm(local, workflow, evalDataset, context) {
  const scorer = context?.llmScorer;
  if (!scorer || !llmClientEnabled(scorer)) return null;

  const payloadObj = {
    prompt: clientCfgPassPrompt(context, scorer),
    workflow,
    eval_dataset: evalDataset,
    local_metrics: local.metrics,
    local_score: local.score
  };

  const systemContent = [
    "你是 MWGL 工作流优化评测小模型。依据 workflow、eval_dataset 条目、local_metrics 与 local_score 给出单一综合分。",
    "只输出一个 JSON 对象，且仅含键 score（数字）：例如 {\"score\":0.75}。禁止 markdown、禁止解释、禁止除该 JSON 外的任何文字。"
  ].join("");

  if (scorer.url) {
    let timer = null;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), scorer.timeout_ms);
      const response = await fetch(scorer.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...scorer.headers
        },
        signal: ctrl.signal,
        body: JSON.stringify(payloadObj)
      });
      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`llm_scorer.url：HTTP ${response.status} ${rawText.slice(0, 520)}`);
      }
      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch {
        throw new Error(`llm_scorer.url：响应非 JSON ${rawText.slice(0, 360)}`);
      }
      const remoteScore = Number(payload?.score);
      if (!Number.isFinite(remoteScore)) {
        throw new Error(`llm_scorer.url：缺少合法 score 字段`);
      }
      return {
        workflow,
        metrics: local.metrics,
        score: remoteScore,
        source: "llm_scorer"
      };
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("llm_scorer.url")) throw e;
      throw new Error(`llm_scorer.url：${e?.message || String(e)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const content = await postChatCompletion(
    scorer,
    [
      { role: "system", content: systemContent },
      { role: "user", content: JSON.stringify(payloadObj) }
    ],
    { jsonObject: true }
  );
  if (!content) return null;
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownFence(content));
  } catch (_e) {
    return null;
  }
  const remoteScore = Number(parsed?.score);
  if (!Number.isFinite(remoteScore)) return null;
  return {
    workflow,
    metrics: local.metrics,
    score: remoteScore,
    source: "llm_scorer"
  };
}

async function evaluateCandidate(workflow, evalDataset, configWeights, context) {
  const local = computeLocalEvaluation(workflow, evalDataset, configWeights);
  const evaluator = context?.evaluator;
  if (evaluator?.url) {
    let timer = null;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), evaluator.timeout_ms);
      const response = await fetch(evaluator.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...evaluator.headers
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          prompt: evaluator.pass_through_prompt ? context?.prompt || "" : "",
          workflow,
          eval_dataset: evalDataset,
          local_metrics: local.metrics,
          local_score: local.score
        })
      });
      if (!response.ok) {
        return { ...local, source: "local_fallback_http_error" };
      }
      const payload = await response.json();
      const remoteScore = Number(payload?.score);
      if (!Number.isFinite(remoteScore)) {
        return { ...local, source: "local_fallback_invalid_remote_score" };
      }
      const remoteMetrics =
        payload?.metrics && typeof payload.metrics === "object"
          ? {
              task_success: safeNumber(payload.metrics.task_success, local.metrics.task_success),
              cost: clamp(safeNumber(payload.metrics.cost, local.metrics.cost), 0, 1),
              latency: clamp(safeNumber(payload.metrics.latency, local.metrics.latency), 0, 1),
              complexity: clamp(safeNumber(payload.metrics.complexity, local.metrics.complexity), 0, 1)
            }
          : local.metrics;
      return {
        workflow,
        metrics: remoteMetrics,
        score: remoteScore,
        source: "remote"
      };
    } catch (_error) {
      return { ...local, source: "local_fallback_exception" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (context?.enable_llmScorer === true) {
    const llmJudged = await scoreViaLlm(local, workflow, evalDataset, context);
    if (llmJudged) return llmJudged;
  }

  return { ...local, source: "local" };
}

function dedupeBySignature(candidates) {
  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = workflowSignature(item.workflow);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function workflowSignature(workflow) {
  const nodeParts = (workflow.nodes || [])
    .map((n) => `${n.id}|${n.type}|${n.text || ""}`)
    .sort();
  const edgeParts = (workflow.edges || [])
    .map((e) => `${e.from}->${e.to}|${e.label || ""}`)
    .sort();
  return `${nodeParts.join(";")}::${edgeParts.join(";")}`;
}

function summarizeTopk(items) {
  return items.map((x) => ({
    id: x.id,
    score: Number(x.score.toFixed(6)),
    metrics: {
      success: Number(x.metrics.task_success.toFixed(6)),
      cost: Number(x.metrics.cost.toFixed(6)),
      latency: Number(x.metrics.latency.toFixed(6)),
      complexity: Number(x.metrics.complexity.toFixed(6))
    },
    op: x.op
  }));
}

async function runBeamSearch(seedCandidates, evalDataset, config, context) {
  let beam = seedCandidates.slice(0, config.beam_width);
  let best = beam[0];
  const history = [];
  const keptMutations = new Set();
  const droppedReasons = { constraint_failed: 0, mutation_failed: 0, invalid_after_normalize: 0 };

  for (let iter = 1; iter <= config.iterations; iter += 1) {
    const pool = [];
    for (const parent of beam) {
      for (let i = 0; i < config.candidates_per_parent; i += 1) {
        const mutation = await mutateWorkflow(parent.workflow, config.max_nodes, context);
        if (!mutation) {
          droppedReasons.mutation_failed += 1;
          continue;
        }
        const normalized = normalizeWorkflow(mutation.workflow);
        const check = validateWorkflowConstraints(normalized);
        if (!check.ok) {
          droppedReasons.constraint_failed += 1;
          continue;
        }
        const judged = await evaluateCandidate(normalized, evalDataset, config.weights, context);
        pool.push({
          ...judged,
          op: mutation.op,
          id: `wf_${iter}_${parent.id}_${i + 1}`
        });
      }
    }

    if (pool.length === 0) break;
    const ranked = dedupeBySignature(pool).sort((a, b) => b.score - a.score);
    if (ranked.length === 0) {
      droppedReasons.invalid_after_normalize += 1;
      break;
    }

    beam = ranked.slice(0, config.beam_width);
    for (const item of beam) keptMutations.add(item.op);
    if (beam[0].score > best.score) best = beam[0];

    history.push({
      iter,
      phase: "beam",
      best_score: Number(beam[0].score.toFixed(6)),
      best_candidate_id: beam[0].id,
      topk: summarizeTopk(beam)
    });
  }

  return { best, history, keptMutations, droppedReasons };
}

async function runMctsSearch(seedCandidates, evalDataset, config, context) {
  const root = {
    id: "mcts_root",
    rewardSum: 0,
    visits: 0,
    op: "forest_root",
    parent: null,
    children: [],
    triedOps: new Set()
  };
  const nodesBySignature = new Map();
  const history = [];
  const keptMutations = new Set();
  const droppedReasons = { constraint_failed: 0, mutation_failed: 0, duplicate_state: 0 };
  let best = seedCandidates[0];
  let nodeCounter = 0;

  for (const seed of seedCandidates) {
    const signature = workflowSignature(seed.workflow);
    if (nodesBySignature.has(signature)) continue;
    nodeCounter += 1;
    const child = {
      id: `mcts_seed_${nodeCounter}`,
      workflow: seed.workflow,
      metrics: seed.metrics,
      score: seed.score,
      rewardSum: 0,
      visits: 0,
      op: "seed",
      parent: root,
      children: [],
      triedOps: new Set(),
      source: seed.source
    };
    root.children.push(child);
    nodesBySignature.set(signature, child);
  }

  if (config.mcts_seed_expand_all_operators) {
    for (const seedNode of root.children) {
      const branches = listAllValidatedOperatorBranches(seedNode.workflow, config.max_nodes);
      for (const br of branches) {
        const sig = workflowSignature(br.workflow);
        if (nodesBySignature.has(sig)) continue;
        nodeCounter += 1;
        const judged = await evaluateCandidate(br.workflow, evalDataset, config.weights, context);
        const branchNode = {
          id: `mcts_seed_br_${nodeCounter}`,
          workflow: br.workflow,
          metrics: judged.metrics,
          score: judged.score,
          rewardSum: 0,
          visits: 0,
          op: br.op,
          parent: seedNode,
          children: [],
          triedOps: new Set(),
          source: judged.source
        };
        nodesBySignature.set(sig, branchNode);
        seedNode.children.push(branchNode);
        keptMutations.add(br.op);
        if (judged.score > best.score) {
          best = {
            workflow: br.workflow,
            metrics: judged.metrics,
            score: judged.score,
            source: judged.source,
            id: branchNode.id,
            op: br.op
          };
        }
      }
    }
  }

  function uctValue(parent, child) {
    if (child.visits === 0) return Number.POSITIVE_INFINITY;
    const exploit = child.rewardSum / child.visits;
    const explore = config.mcts_exploration * Math.sqrt(Math.log(parent.visits + 1) / child.visits);
    return exploit + explore;
  }

  function selectNode(startNode) {
    let cur = startNode;
    while (cur.children.length > 0) {
      let picked = cur.children[0];
      let bestUct = uctValue(cur, picked);
      for (const child of cur.children.slice(1)) {
        const v = uctValue(cur, child);
        if (v > bestUct) {
          bestUct = v;
          picked = child;
        }
      }
      cur = picked;
    }
    return cur;
  }

  async function expandNode(leaf) {
    for (let tries = 0; tries < 8; tries += 1) {
      const mutation = await mutateWorkflow(leaf.workflow, config.max_nodes, context);
      if (!mutation) {
        droppedReasons.mutation_failed += 1;
        continue;
      }
      const normalized = normalizeWorkflow(mutation.workflow);
      const check = validateWorkflowConstraints(normalized);
      if (!check.ok) {
        droppedReasons.constraint_failed += 1;
        continue;
      }
      const signature = workflowSignature(normalized);
      if (nodesBySignature.has(signature)) {
        droppedReasons.duplicate_state += 1;
        continue;
      }
      nodeCounter += 1;
      const judged = await evaluateCandidate(normalized, evalDataset, config.weights, context);
      const child = {
        id: `mcts_${nodeCounter}`,
        workflow: normalized,
        metrics: judged.metrics,
        score: judged.score,
        rewardSum: 0,
        visits: 0,
        op: mutation.op,
        parent: leaf,
        children: [],
        triedOps: new Set(),
        source: judged.source
      };
      nodesBySignature.set(signature, child);
      leaf.children.push(child);
      keptMutations.add(mutation.op);
      return child;
    }
    return null;
  }

  async function rollout(startNode) {
    let current = startNode.workflow;
    let evalResult = { metrics: startNode.metrics, score: startNode.score };
    for (let step = 0; step < config.mcts_rollout_steps; step += 1) {
      const mutation = await mutateWorkflow(current, config.max_nodes, context);
      if (!mutation) break;
      const normalized = normalizeWorkflow(mutation.workflow);
      const check = validateWorkflowConstraints(normalized);
      if (!check.ok) continue;
      evalResult = await evaluateCandidate(normalized, evalDataset, config.weights, context);
      current = normalized;
    }
    return evalResult.score;
  }

  function backpropagate(node, reward) {
    let cur = node;
    while (cur) {
      cur.visits += 1;
      cur.rewardSum += reward;
      cur = cur.parent;
    }
  }

  for (let iter = 1; iter <= config.iterations; iter += 1) {
    const leaf = selectNode(root);
    const expanded = (await expandNode(leaf)) || leaf;
    const reward = await rollout(expanded);
    backpropagate(expanded, reward);

    if (expanded.score > best.score) {
      best = expanded;
    }
    const frontier = root.children
      .map((n) => ({
        id: n.id,
        op: n.op,
        score: n.score,
        visits: n.visits,
        meanReward: n.visits > 0 ? n.rewardSum / n.visits : 0,
        metrics: n.metrics,
        source: n.source || "unknown"
      }))
      .sort((a, b) => b.meanReward - a.meanReward)
      .slice(0, config.beam_width);

    history.push({
      iter,
      phase: "mcts",
      best_score: Number(best.score.toFixed(6)),
      best_candidate_id: best.id,
      root_visits: root.visits,
      topk: frontier.map((x) => ({
        id: x.id,
        score: Number(x.score.toFixed(6)),
        mean_reward: Number(x.meanReward.toFixed(6)),
        visits: x.visits,
        metrics: {
          success: Number(x.metrics.task_success.toFixed(6)),
          cost: Number(x.metrics.cost.toFixed(6)),
          latency: Number(x.metrics.latency.toFixed(6)),
          complexity: Number(x.metrics.complexity.toFixed(6))
        },
        op: x.op
      }))
    });
  }

  return { best, history, keptMutations, droppedReasons, root };
}

router.post("/api/mwgl/optimize", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "").trim();
    const singleWorkflow = req.body?.initial_workflow ? deepClone(req.body.initial_workflow) : null;
    const multipleWorkflows = Array.isArray(req.body?.initial_workflows)
      ? req.body.initial_workflows.map((x) => deepClone(x))
      : [];
    const candidateSeeds = [];
    if (singleWorkflow) candidateSeeds.push(singleWorkflow);
    for (const wf of multipleWorkflows) candidateSeeds.push(wf);
    if (candidateSeeds.length === 0) {
      return res.status(400).json({ error: "initial_workflow or initial_workflows is required" });
    }

    const config = mergeConfig(req.body?.config);
    const rawEvalDataset = Array.isArray(req.body?.eval_dataset) ? req.body.eval_dataset : [];
    const evalDataset = selectRelevantEvalDataset(rawEvalDataset, prompt, config);
    const evaluator = mergeEvaluatorConfig(req.body?.evaluator);
    let llmMutator = mergeLlmMutatorConfig(req.body?.llm_mutator);
    llmMutator = mergeQwenFromEnvDefaults(llmMutator);
    llmMutator = finalizeQwenCredentials(llmMutator);

    let llmExpand = mergeLlmExpandConfig(req.body?.llm_expand);
    llmExpand = mergeQwenFromEnvDefaults(llmExpand);
    llmExpand = finalizeQwenCredentials(llmExpand);

    let llmScorer = mergeLlmScorerConfig(req.body?.llm_scorer);
    llmScorer = mergeQwenFromEnvDefaults(llmScorer);
    llmScorer = finalizeQwenCredentials(llmScorer);

    const blockedDeepSeek =
      [llmMutator, llmExpand, llmScorer].some(
        (cfg) => endpointLooksLikeDeepSeek(cfg?.url) || endpointLooksLikeDeepSeek(cfg?.base_url)
      );
    if (blockedDeepSeek) {
      return res.status(422).json({
        error: "optimize forbids DeepSeek endpoints",
        details:
          "优化接口仅允许 Qwen（DashScope 兼容 OpenAI）。请勿将 llm_mutator / llm_expand / llm_scorer 指向 DeepSeek；DeepSeek 兜底已关闭。"
      });
    }

    const mutatorOk = llmClientEnabled(llmMutator);
    const expandOk = llmClientEnabled(llmExpand);
    if (config.mutation_mode === "llm_generate") {
      if (!expandOk && !mutatorOk) {
        return res.status(422).json({
          error: "llm_generate requires llm_expand or llm_mutator credentials",
          details:
            "Provide llm_expand OR llm_mutator with url OR (base_url + api_key + model). Mutator is used when expand is omitted. Env: QWEN_API_KEY, QWEN_BASE_URL, QWEN_MODEL."
        });
      }
    } else if (!mutatorOk) {
      return res.status(422).json({
        error: "llm_mutator is required in operator_select mode",
        details:
          "Provide llm_mutator.url OR (llm_mutator.base_url + llm_mutator.api_key + llm_mutator.model). Server fills only from QWEN_API_KEY, QWEN_BASE_URL, QWEN_MODEL when .env is loaded.",
        diagnostics: mutatorDiagnostics(llmMutator)
      });
    }
    const context = {
      prompt,
      evaluator,
      llmMutator,
      llmExpand,
      llmScorer,
      mutationMode: config.mutation_mode,
      llmGenerateMaxRetries: config.llm_generate_max_retries,
      enableLlmScorer: config.enable_llm_scorer
    };

    const validSeeds = [];
    const rejectedSeeds = [];
    for (let i = 0; i < candidateSeeds.length; i += 1) {
      const normalizedSeed = normalizeWorkflow(candidateSeeds[i]);
      const seedCheck = validateWorkflowConstraints(normalizedSeed);
      if (!seedCheck.ok) {
        rejectedSeeds.push({ index: i, errors: seedCheck.errors });
        continue;
      }
      validSeeds.push(normalizedSeed);
    }

    if (validSeeds.length === 0) {
      return res.status(422).json({
        error: "all initial workflows failed validation",
        details: rejectedSeeds
      });
    }

    const seedCandidates = [];
    let seedCounter = 0;
    for (const seed of dedupeBySignature(validSeeds.map((workflow) => ({ workflow }))).map((x) => x.workflow)) {
      seedCounter += 1;
      const judged = await evaluateCandidate(seed, evalDataset, config.weights, context);
      seedCandidates.push({ ...judged, op: "seed", id: `wf_seed_${seedCounter}` });
    }
    seedCandidates.sort((a, b) => b.score - a.score);

    const runResult =
      config.algorithm === "mcts"
        ? await runMctsSearch(seedCandidates, evalDataset, config, context)
        : await runBeamSearch(seedCandidates, evalDataset, config, context);

    res.json({
      prompt,
      config,
      evaluator: {
        enabled: Boolean(evaluator.url),
        url: evaluator.url || null,
        timeout_ms: evaluator.timeout_ms
      },
      llm_mutator: {
        enabled: Boolean(llmMutator.url || (llmMutator.base_url && llmMutator.api_key && llmMutator.model)),
        url: llmMutator.url || null,
        base_url: llmMutator.url ? null : llmMutator.base_url || null,
        timeout_ms: llmMutator.timeout_ms,
        mutation_ratio: llmMutator.mutation_ratio,
        model: llmMutator.model || null,
        temperature: llmMutator.temperature,
        max_tokens: llmMutator.max_tokens
      },
      llm_expand: {
        enabled: expandOk,
        url: llmExpand.url || null,
        base_url: llmExpand.url ? null : llmExpand.base_url || null,
        timeout_ms: llmExpand.timeout_ms,
        model: llmExpand.model || null,
        temperature: llmExpand.temperature,
        max_tokens: llmExpand.max_tokens
      },
      llm_scorer: {
        enabled: llmClientEnabled(llmScorer),
        url: llmScorer.url || null,
        base_url: llmScorer.url ? null : llmScorer.base_url || null,
        model: llmScorer.model || null
      },
      seed_stats: {
        accepted: seedCandidates.length,
        rejected: rejectedSeeds.length
      },
      eval_dataset_stats: {
        requested: rawEvalDataset.length,
        used: evalDataset.length,
        retrieval_mode: config.retrieval_mode
      },
      best_workflow: runResult.best.workflow,
      best_score: Number(runResult.best.score.toFixed(6)),
      history: runResult.history,
      explain: {
        kept_mutations: Array.from(runResult.keptMutations),
        dropped_reasons: Object.entries(runResult.droppedReasons)
          .filter(([, v]) => v > 0)
          .map(([k]) => k)
      }
    });
  } catch (error) {
    const msg = error?.message || "server error";
    const upstream =
      msg.includes("Qwen chat/completions") ||
      msg.includes("（operator_select）") ||
      msg.startsWith("llm_expand.url") ||
      msg.startsWith("llm_scorer.url");
    res.status(upstream ? 502 : 500).json({ error: msg });
  }
});

export default router;
