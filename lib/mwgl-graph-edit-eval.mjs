/**
 * 可选：调用 RobustFlow graph_evaluator 计算候选图相对参照图的节点/图级 F1。
 * 默认开启；未配置 RobustFlow 时优化会跳过图编辑打分（不中断）。需 ROBUSTFLOW_ROOT、Python 依赖与句向量模型方可生效。
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { mwglToEvalGraph } from "./mwgl-graph-edit-adapter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MWGL_ROOT = path.resolve(__dirname, "..");
const GRAPH_EDIT_SCRIPT = path.join(MWGL_ROOT, "tools", "graph_edit_score.py");

/** @param {boolean} defaultWhenUnset 环境变量未设置时的取值 */
function envBool(name, defaultWhenUnset = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultWhenUnset;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

/** @returns {import('./mwgl-graph-edit-eval.mjs').GraphEditEvalConfig} */
export function graphEditConfigFromEnv() {
  return {
    enabled: envBool("MWGL_GRAPH_EDIT_EVAL", true),
    weight: clamp(Number(process.env.MWGL_GRAPH_EDIT_WEIGHT) || 0.2, 0, 1),
    sentence_model:
      String(process.env.MWGL_GRAPH_EDIT_SENTENCE_MODEL || "").trim() ||
      "sentence-transformers/all-mpnet-base-v2",
    local_files_only: envBool("MWGL_GRAPH_EDIT_LOCAL_FILES_ONLY", false),
    timeout_ms: clamp(Math.floor(Number(process.env.MWGL_GRAPH_EDIT_TIMEOUT_MS) || 180000), 5000, 600000),
    python_bin: String(process.env.MWGL_PYTHON_BIN || "python3").trim() || "python3"
  };
}

/**
 * @param {object|undefined} input
 * @param {ReturnType<typeof graphEditConfigFromEnv>} envDefaults
 */
export function mergeGraphEditEvalConfig(input, envDefaults = graphEditConfigFromEnv()) {
  const source = input && typeof input === "object" ? input : {};
  let enabled = envDefaults.enabled;
  if (source.enabled === true) enabled = true;
  if (source.enabled === false) enabled = false;

  return {
    enabled,
    weight: clamp(Number(source.weight ?? envDefaults.weight), 0, 1),
    sentence_model: String(source.sentence_model || envDefaults.sentence_model).trim(),
    local_files_only:
      source.local_files_only === true
        ? true
        : source.local_files_only === false
          ? false
          : envDefaults.local_files_only,
    timeout_ms: clamp(
      Math.floor(Number(source.timeout_ms ?? envDefaults.timeout_ms)),
      5000,
      600000
    ),
    python_bin: String(source.python_bin || envDefaults.python_bin).trim() || "python3"
  };
}

function lexicalSimilarity(a, b) {
  const ga = mwglToEvalGraph(a);
  const gb = mwglToEvalGraph(b);
  const na = new Set((ga.nodes || []).filter((x) => x && x !== "START"));
  const nb = new Set((gb.nodes || []).filter((x) => x && x !== "START"));
  if (na.size === 0 && nb.size === 0) return { node_f1: 1, graph_f1: 1, similarity: 1, mode: "lexical" };
  if (na.size === 0 || nb.size === 0) return { node_f1: 0, graph_f1: 0, similarity: 0, mode: "lexical" };
  let hit = 0;
  for (const x of na) if (nb.has(x)) hit += 1;
  const prec = hit / na.size;
  const rec = hit / nb.size;
  const f1 = prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
  const edgeA = (ga.edges || []).length;
  const edgeB = (gb.edges || []).length;
  const edgeSim =
    edgeA === 0 && edgeB === 0 ? 1 : edgeA === 0 || edgeB === 0 ? 0 : Math.min(edgeA, edgeB) / Math.max(edgeA, edgeB);
  const similarity = (f1 + edgeSim) / 2;
  return {
    node_f1: Number(f1.toFixed(6)),
    graph_f1: Number(edgeSim.toFixed(6)),
    similarity: Number(similarity.toFixed(6)),
    mode: "lexical"
  };
}

/**
 * @param {object} referenceWorkflow
 * @param {object[]} candidateWorkflows
 * @param {ReturnType<typeof mergeGraphEditEvalConfig>} options
 */
export function scoreGraphEditBatch(referenceWorkflow, candidateWorkflows, options) {
  const candidates = Array.isArray(candidateWorkflows) ? candidateWorkflows : [];
  if (!referenceWorkflow || typeof referenceWorkflow !== "object") {
    return { ok: false, error: "reference_workflow required", scores: [] };
  }
  if (candidates.length === 0) {
    return { ok: true, scores: [] };
  }

  if (!fs.existsSync(GRAPH_EDIT_SCRIPT)) {
    return { ok: false, error: "graph_edit_score.py not found", scores: [] };
  }

  const payload = {
    reference: referenceWorkflow,
    candidates,
    sentence_model: options.sentence_model,
    local_files_only: options.local_files_only
  };

  try {
    const out = execFileSync(options.python_bin, [GRAPH_EDIT_SCRIPT], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: options.timeout_ms,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: MWGL_ROOT
    });
    const parsed = JSON.parse(out);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error || "graph_edit failed", scores: [] };
    }
    return {
      ok: true,
      scores: (parsed.scores || []).map((s) => ({ ...s, mode: "robustflow" })),
      reference_nodes: parsed.reference_nodes
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      scores: candidates.map(() => ({
        node_f1: 0,
        graph_f1: 0,
        similarity: 0,
        error: "python_invoke_failed",
        mode: "none"
      }))
    };
  }
}

/**
 * @param {object} referenceWorkflow
 * @param {object} candidateWorkflow
 * @param {ReturnType<typeof mergeGraphEditEvalConfig>} options
 * @param {{ lexical_fallback?: boolean }} extra
 */
export function scoreGraphEditPair(referenceWorkflow, candidateWorkflow, options, extra = {}) {
  const batch = scoreGraphEditBatch(referenceWorkflow, [candidateWorkflow], options);
  if (batch.ok && batch.scores[0]) {
    return { ok: true, ...batch.scores[0] };
  }
  if (extra.lexical_fallback) {
    const lex = lexicalSimilarity(referenceWorkflow, candidateWorkflow);
    return { ok: true, ...lex, fallback: true, python_error: batch.error };
  }
  return { ok: false, error: batch.error || "graph_edit failed" };
}

/**
 * 将图编辑相似度混入本地分（不改变 task_success 子项，只调最终 score）
 */
export function blendScoreWithGraphEdit(localScore, graphSimilarity, weight) {
  const w = clamp(Number(weight) || 0, 0, 1);
  const base = clamp(Number(localScore) || 0, 0, 1);
  const sim = clamp(Number(graphSimilarity) || 0, 0, 1);
  return clamp((1 - w) * base + w * sim, 0, 1);
}
