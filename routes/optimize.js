import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Router } from "express";
import { normalizeWorkflow, validateWorkflowConstraints } from "../js/mwgl.js";

const router = Router();

const DEFAULT_CONFIG = {
  algorithm: "beam",
  iterations: 12,
  beam_width: 4,
  candidates_per_parent: 4,
  mcts_exploration: 1.2,
  mcts_rollout_steps: 2,
  eval_topk: 24,
  retrieval_mode: "faiss",
  max_nodes: 40,
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
  base_url: process.env.QWEN_BASE_URL || process.env.DEEPSEEK_API_BASE || "https://dashscope.aliyuncs.com/compatible-mode/v1",
  timeout_ms: 8000,
  pass_through_prompt: true,
  mutation_ratio: 0.85,
  model: process.env.QWEN_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat",
  temperature: 0.2,
  max_tokens: 800,
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
  cfg.eval_topk = clamp(Math.floor(safeNumber(source.eval_topk, cfg.eval_topk)), 0, 200);
  cfg.retrieval_mode = String(source.retrieval_mode || cfg.retrieval_mode).trim().toLowerCase() === "faiss" ? "faiss" : "token";
  cfg.max_nodes = clamp(Math.floor(safeNumber(source.max_nodes, cfg.max_nodes)), 4, 500);
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
  cfg.model = String(source.model || "").trim();
  cfg.temperature = clamp(safeNumber(source.temperature, cfg.temperature), 0, 2);
  cfg.max_tokens = clamp(Math.floor(safeNumber(source.max_tokens, cfg.max_tokens)), 64, 8192);
  cfg.api_key = String(source.api_key || process.env.QWEN_API_KEY || process.env.DEEPSEEK_API_KEY || "").trim();
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

function listValidOperatorChoices(parentWorkflow, maxNodes) {
  const validChoices = [];
  for (const opFn of OPERATORS) {
    const candidate = opFn(parentWorkflow);
    if (!candidate) continue;
    if ((candidate.workflow.nodes || []).length > maxNodes) continue;
    const normalized = normalizeWorkflow(candidate.workflow);
    const check = validateWorkflowConstraints(normalized);
    if (!check.ok) continue;
    validChoices.push({
      op: candidate.op,
      workflow: normalized
    });
  }
  return validChoices;
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
            "Return strict JSON only: {'decision':'choose','op':'<one_of_available_operators>'} or {'decision':'reject','reason':'...'}."
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
              content:
                "You are an MWGL mutation operator selector. You must select exactly one operator from available_operators, or reject when none can safely improve. Return strict JSON only: {'decision':'choose','op':'...'} or {'decision':'reject','reason':'...'}."
            },
            {
              role: "user",
              content: JSON.stringify({
                prompt: llmMutator.pass_through_prompt ? context?.prompt || "" : "",
                workflow: parentWorkflow,
                max_nodes: maxNodes,
                available_operators: availableOps
              })
            }
          ]
        })
      });
    }
    if (!response.ok) return null;
    let payload = await response.json();
    if (!llmMutator.url) {
      const content = payload?.choices?.[0]?.message?.content;
      if (!content) return null;
      try {
        payload = JSON.parse(content);
      } catch (_e) {
        return null;
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
  } catch (_error) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mutateWorkflow(parentWorkflow, maxNodes, context) {
  const llmMutator = context?.llmMutator;
  const hasLlmEndpoint = Boolean(
    llmMutator?.url || (llmMutator?.base_url && llmMutator?.api_key && llmMutator?.model)
  );
  if (!hasLlmEndpoint) {
    return null;
  }
  const llmCandidate = await mutateWorkflowViaLlm(parentWorkflow, maxNodes, context);
  if (llmCandidate && !llmCandidate.rejected) return llmCandidate;
  return null;
}

function computeLocalEvaluation(workflow, evalDataset, configWeights) {
  const metrics = computeMetrics(workflow, evalDataset);
  const score = computeScore(metrics, configWeights);
  return { workflow, metrics, score };
}

async function evaluateCandidate(workflow, evalDataset, configWeights, context) {
  const local = computeLocalEvaluation(workflow, evalDataset, configWeights);
  const evaluator = context?.evaluator;
  if (!evaluator?.url) {
    return { ...local, source: "local" };
  }

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
    const llmMutator = mergeLlmMutatorConfig(req.body?.llm_mutator);
    const llmEnabled = Boolean(llmMutator.url || (llmMutator.base_url && llmMutator.api_key && llmMutator.model));
    if (!llmEnabled) {
      return res.status(422).json({
        error: "llm_mutator is required in strict_llm_operator_mode",
        details:
          "Provide llm_mutator.url OR (llm_mutator.base_url + llm_mutator.api_key + llm_mutator.model)."
      });
    }
    const context = { prompt, evaluator, llmMutator };

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
    res.status(500).json({ error: error.message || "server error" });
  }
});

export default router;
