import "../load-env.js";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Router } from "express";
import { normalizeWorkflow, validateWorkflowConstraints } from "../js/mwgl.js";
import { suggestOpsForWorkflow, isRuleMutationMode } from "./optimize-experience.js";
import {
  MUTATION_OPERATORS,
  MUTATION_OP_IDS,
  MUTATION_SEMANTICS_ZH
} from "./optimize-mutations.js";
import {
  scoreWorkflow,
  DEFAULT_SCORE_WEIGHTS,
  mutationReward
} from "./optimize-scoring.js";
import { runTop4Search } from "../lib/mwgl-top4-search.mjs";
import {
  mergeGraphEditEvalConfig,
  graphEditConfigFromEnv,
  scoreGraphEditPair,
  blendScoreWithGraphEdit
} from "../lib/mwgl-graph-edit-eval.mjs";

const router = Router();

/** 优化路径仅允许 Qwen（DashScope 兼容 OpenAI）。不设 DeepSeek / 固定 DashScope URL 兜底；缺省项依赖 QWEN_*。 */
const DEFAULT_QWEN_BASE = String(process.env.QWEN_BASE_URL || "").trim().replace(/\/$/, "");

const DEFAULT_CONFIG = {
  algorithm: "top4",
  eval_topk: 24,
  retrieval_mode: "faiss",
  max_nodes: 40,
  mutation_mode: "llm_generate",
  llm_generate_max_retries: 3,
  enable_llm_scorer: false,
  weights: { ...DEFAULT_SCORE_WEIGHTS },
  /** beam（默认）| mcts */
  top4_search_mode: "beam",
  top4_keep: 4,
  top4_rounds: 2,
  /** 仅 mcts：在 top4_rounds 之后再扩展的轮数 */
  top4_mcts_extra_rounds: 1,
  top4_mcts_exploration: 1.2,
  top4_initial_pool: 8,
  /** 固定 2：内容 + 结构双分支（见 MUTATION_BRANCHES） */
  top4_children_per_parent: 2
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

const TERMINAL_TYPES = new Set(["end"]);
const NON_TERMINAL_TYPES = new Set(["start", "step", "branch"]);

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
  cfg.algorithm = "top4";
  cfg.mutation_mode = "llm_generate";
  cfg.eval_topk = clamp(Math.floor(safeNumber(source.eval_topk, cfg.eval_topk)), 0, 200);
  cfg.retrieval_mode = String(source.retrieval_mode || cfg.retrieval_mode).trim().toLowerCase() === "faiss" ? "faiss" : "token";
  cfg.max_nodes = clamp(Math.floor(safeNumber(source.max_nodes, cfg.max_nodes)), 4, 500);
  const mode = String(source.top4_search_mode || cfg.top4_search_mode).trim().toLowerCase();
  cfg.top4_search_mode = mode === "mcts" ? "mcts" : "beam";
  cfg.top4_keep = clamp(Math.floor(safeNumber(source.top4_keep, cfg.top4_keep)), 1, 12);
  cfg.top4_rounds = clamp(Math.floor(safeNumber(source.top4_rounds, cfg.top4_rounds)), 1, 12);
  cfg.top4_initial_pool = clamp(
    Math.floor(safeNumber(source.top4_initial_pool, cfg.top4_initial_pool)),
    1,
    24
  );
  cfg.top4_mcts_extra_rounds = clamp(
    Math.floor(safeNumber(source.top4_mcts_extra_rounds, cfg.top4_mcts_extra_rounds)),
    0,
    8
  );
  cfg.top4_mcts_exploration = clamp(
    safeNumber(source.top4_mcts_exploration, cfg.top4_mcts_exploration),
    0.05,
    5
  );
  cfg.top4_children_per_parent = 2;
  cfg.llm_generate_max_retries = clamp(
    Math.floor(safeNumber(source.llm_generate_max_retries, cfg.llm_generate_max_retries)),
    1,
    8
  );
  cfg.enable_llm_scorer = source.enable_llm_scorer === true;
  for (const key of Object.keys(DEFAULT_SCORE_WEIGHTS)) {
    if (source.weights?.[key] !== undefined) {
      cfg.weights[key] = safeNumber(source.weights[key], cfg.weights[key]);
    }
  }
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

const MWGL_V3_HARD_RULES_ZH = [
  "【结构】全图为 DAG；禁止自环；end 禁止出边。",
  "【类型】仅 start | step | branch | end；end 须含 outcome: success | failure。",
  "【入口】唯一 start，无入边，至少一条出边。",
  "【步骤】step 最多 1 条出边。",
  "【分支】branch 至少 2 条出边；每条出边 label 非空、不重复、有业务语义（禁纯数字/分支N）。",
  "【终态】至少一个从 start 可达的 end；可达非 end 节点须能到达 end。",
  "【失败】outcome=failure 的 end 文案须具体，不能仅写「失败」。",
  "【规模】节点数 ≤ max_nodes。循环/并行不在图中建模，写在 step 文案或由代码生成处理。"
].join("\n");

const OPERATOR_SELECT_SYSTEM_ZH = [
  "你是 MWGL v3 变异算子选择器。只能从 available_operators 中选一项。",
  '输出 {"decision":"choose","op":"..."} 或 {"decision":"reject","reason":"..."}。禁止 markdown。'
].join("\n");

function listRelevantOperatorHints(parentWorkflow, maxNodes) {
  const hints = [];
  for (const opFn of MUTATION_OPERATORS) {
    const candidate = opFn(parentWorkflow);
    if (!candidate) continue;
    if ((candidate.workflow.nodes || []).length > maxNodes) continue;
    hints.push(candidate.op);
  }
  return hints;
}

const LLM_GENERATE_SYSTEM = [
  "你是 MWGL v3 工作流合法改写模型。输出完整 JSON 工作流，无 markdown。",
  MWGL_V3_HARD_RULES_ZH,
  "顶层：mwgl_version:3, rule_id, rule_name, nodes, edges。nodes：id,type,text,x,y；type=end 时含 outcome。edges：id,from,to,label。",
  "type 枚举：start, step, branch, end。"
].join("\n");

/** 束搜索 / MCTS 扩展时按「内容」「结构」分支注入 system 侧重点 */
function buildLlmGenerateSystem(context) {
  const focus = context?.mutationFocus;
  if (!focus?.instruction_zh) return LLM_GENERATE_SYSTEM;
  const label = focus.id === "structure" ? "结构" : "内容";
  return [
    LLM_GENERATE_SYSTEM,
    "",
    `【本轮改写类型：${label}（mutation_focus=${focus.id}）】`,
    "必须严格按用户 JSON 中的 mutation_instruction_zh 执行；不得同时做大范围拓扑重写与全文润色。",
    focus.instruction_zh
  ].join("\n");
}

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
  const ops = relevantHints.length > 0 ? relevantHints : MUTATION_OP_IDS;
  const focus = context?.mutationFocus;
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
      "服务端使用与本仓库 mwgl-v3.js 中 validateWorkflowConstraints 相同的规则校验你的输出；repair 阶段必须消除列出的全部 validation_errors。"
  };
  if (focus?.id && focus?.instruction_zh) {
    base.mutation_focus = focus.id;
    base.mutation_instruction_zh = focus.instruction_zh;
  }
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
  if (relevantHints.length === 0) relevantHints = [...MUTATION_OP_IDS];

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
      { role: "system", content: buildLlmGenerateSystem(context) },
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
  const focusId = context?.mutationFocus?.id;
  const op =
    focusId === "content"
      ? "llm_generate_content"
      : focusId === "structure"
        ? "llm_generate_structure"
        : "llm_generate";
  return { workflow: checked.normalized, op };
}

/** 仅按「能不能执行这条算子」与节点上限筛选（operator_select 用） */
function listValidOperatorChoices(parentWorkflow, maxNodes) {
  const validChoices = [];
  for (const opFn of MUTATION_OPERATORS) {
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

function mutateWorkflowByRule(parentWorkflow, maxNodes, context) {
  const mode = context?.mutationMode || "rule_bandit";
  const validChoices = listValidOperatorChoices(parentWorkflow, maxNodes);
  if (validChoices.length === 0) return null;

  const parentSig = workflowSignature(parentWorkflow);
  const preferred = suggestOpsForWorkflow(parentWorkflow, validateWorkflowConstraints);

  if (mode === "rule_random") {
    const picked = validChoices[Math.floor(Math.random() * validChoices.length)];
    return { workflow: picked.workflow, op: picked.op, parentSig };
  }

  const experience = context?.experience;
  if (!experience) {
    const picked = validChoices[Math.floor(Math.random() * validChoices.length)];
    return { workflow: picked.workflow, op: picked.op, parentSig };
  }

  const picked = experience.selectOperator(parentSig, validChoices, preferred);
  if (!picked) return null;
  return { workflow: picked.workflow, op: picked.op, parentSig };
}

async function mutateWorkflow(parentWorkflow, maxNodes, context) {
  const mode = context?.mutationMode || "rule_bandit";

  if (isRuleMutationMode(mode)) {
    return mutateWorkflowByRule(parentWorkflow, maxNodes, context);
  }

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

function recordMutationReward(context, parent, mutation, childScore) {
  if (!context?.experience || !mutation?.op || !mutation?.parentSig) return;
  const parentScore = Number(parent?.score) || 0;
  context.experience.record(
    mutation.parentSig,
    mutation.op,
    mutationReward(parentScore, childScore)
  );
}

function computeLocalEvaluation(workflow, evalDataset, configWeights, context) {
  const result = scoreWorkflow(workflow, {
    evalDataset,
    prompt: context?.prompt || "",
    weights: configWeights
  });
  return {
    workflow,
    metrics: result.metrics,
    score: result.score,
    details: result.details
  };
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

function applyGraphEditToEvaluation(local, workflow, context) {
  const ge = context?.graphEditEval;
  if (!ge?.enabled || !ge?.referenceWorkflow) {
    return local;
  }

  const scored = scoreGraphEditPair(ge.referenceWorkflow, workflow, ge, {
    lexical_fallback: ge.lexical_fallback === true
  });
  if (!scored.ok) {
    return {
      ...local,
      details: {
        ...(local.details || {}),
        graph_edit_skipped: scored.error || "graph_edit_unavailable"
      }
    };
  }

  const blended = blendScoreWithGraphEdit(local.score, scored.similarity, ge.weight);
  return {
    ...local,
    score: Number(blended.toFixed(6)),
    metrics: {
      ...local.metrics,
      graph_edit_node_f1: scored.node_f1,
      graph_edit_graph_f1: scored.graph_f1,
      graph_edit_similarity: scored.similarity
    },
    details: {
      ...(local.details || {}),
      graph_edit_mode: scored.mode,
      graph_edit_fallback: Boolean(scored.fallback),
      graph_edit_local_score: local.score
    }
  };
}

async function evaluateCandidate(workflow, evalDataset, configWeights, context) {
  let local = computeLocalEvaluation(workflow, evalDataset, configWeights, context);
  local = applyGraphEditToEvaluation(local, workflow, context);
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
          local_score: local.score,
          weights: configWeights
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
          ? { ...local.metrics, ...payload.metrics }
          : local.metrics;
      return {
        workflow,
        metrics: remoteMetrics,
        score: clamp(remoteScore, 0, 1),
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
    const config = mergeConfig(req.body?.config);

    if (candidateSeeds.length === 0 && !prompt) {
      return res.status(400).json({
        error: "prompt or initial_workflow is required",
        details: "无种子图时需 prompt 以并行 DeepSeek 生成初稿。"
      });
    }
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

    if (!expandOk && !mutatorOk) {
      return res.status(422).json({
        error: "optimize requires llm_expand or llm_mutator (Qwen)",
        details:
          "Top-4 在第 1 轮起对父代并行 llm_generate。请配置 QWEN_API_KEY、QWEN_BASE_URL、QWEN_MODEL。"
      });
    }

    const graphEditCfg = mergeGraphEditEvalConfig(req.body?.graph_edit_eval, graphEditConfigFromEnv());
    let referenceWorkflow = req.body?.reference_workflow
      ? normalizeWorkflow(req.body.reference_workflow)
      : null;

    const context = {
      prompt,
      evaluator,
      llmMutator,
      llmExpand,
      llmScorer,
      experience: null,
      mutationMode: "llm_generate",
      llmGenerateMaxRetries: config.llm_generate_max_retries,
      enableLlmScorer: config.enable_llm_scorer,
      graphEditEval: graphEditCfg.enabled
        ? {
            ...graphEditCfg,
            referenceWorkflow,
            lexical_fallback: req.body?.graph_edit_eval?.lexical_fallback === true
          }
        : null
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

    if (validSeeds.length === 0 && !prompt) {
      return res.status(422).json({
        error: "no valid initial workflow and no prompt",
        details: rejectedSeeds
      });
    }

    const top4Seeds = dedupeBySignature(validSeeds.map((workflow) => ({ workflow }))).map(
      (x) => x.workflow
    );

    if (context.graphEditEval?.enabled && !context.graphEditEval.referenceWorkflow && top4Seeds.length > 0) {
      context.graphEditEval.referenceWorkflow = top4Seeds[0];
    }

    const runResult = await runTop4Search({
      prompt,
      seedWorkflows: top4Seeds,
      evalDataset,
      config,
      context,
      evaluateCandidate,
      mutateWorkflow
    });
    if (!runResult.best?.workflow) {
      return res.status(422).json({
        error: "optimize produced no valid workflow",
        history: runResult.history,
        dropped: runResult.dropped
      });
    }

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
      graph_edit_eval: context.graphEditEval
        ? {
            enabled: context.graphEditEval.enabled,
            weight: context.graphEditEval.weight,
            reference_from:
              req.body?.reference_workflow != null
                ? "request"
                : top4Seeds.length > 0
                  ? "initial_seed"
                  : "initial_pool_top1",
            lexical_fallback: context.graphEditEval.lexical_fallback === true
          }
        : { enabled: false },
      seed_stats: {
        accepted: validSeeds.length,
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
      search_stats: {
        stopped_early: Boolean(runResult.stoppedEarly),
        global_best_id: runResult.best?.id ?? null,
        top4: {
          dropped: runResult.dropped,
          final_pool: runResult.pool?.length,
          mcts: runResult.mcts
        }
      },
      explain: {
        mode: config.top4_search_mode === "mcts" ? "top4_mcts" : "top4_beam",
        search_mode: runResult.search_mode || config.top4_search_mode,
        selection: "global_best",
        rounds: config.top4_rounds,
        mcts_extra_rounds:
          config.top4_search_mode === "mcts" ? config.top4_mcts_extra_rounds : 0,
        branches: ["content", "structure"],
        keep: config.top4_keep,
        mcts: runResult.mcts,
        history: runResult.history
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
