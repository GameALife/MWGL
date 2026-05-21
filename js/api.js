import { normalizeWorkflow } from "./mwgl.js";

export async function buildWorkflowByDeepSeek({ base, prompt }) {
  const res = await fetch(`${base}/api/mwgl/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ prompt })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = await res.json();
  const content = data?.content || "";
  const cleaned = content
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  return normalizeWorkflow(parsed);
}

export async function dagToPseudocode({
  base,
  workflow,
  mode = "regen",
  existingPseudocode = "",
  revisionNotes = ""
}) {
  const res = await fetch(`${base}/api/mwgl/pseudocode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      workflow,
      mode: mode === "incremental" ? "incremental" : "regen",
      existingPseudocode,
      revisionNotes
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = await res.json();
  return {
    content: data?.content || "",
    mainFlow: data?.mainFlow || "",
    nodeFiles: data?.nodeFiles || {}
  };
}

/** 首图人工修订阶段的结构化建议。 */
export async function fetchWorkflowSuggestions({ base, workflow, prompt, evalDataset }) {
  const root = String(base || "").trim().replace(/\/$/, "");
  const res = await fetch(`${root}/api/mwgl/workflow-suggestions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workflow,
      prompt: String(prompt || "").trim(),
      eval_dataset: Array.isArray(evalDataset) ? evalDataset : []
    })
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`suggestions 返回非 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(data?.error || text.slice(0, 240));
  }
  return data;
}

/** 拉取服务端评测集（JSON 数组），失败返回空数组。 */
export async function fetchEvalDataset({ base }) {
  const root = String(base || "").trim().replace(/\/$/, "");
  if (!root) return [];
  try {
    const res = await fetch(`${root}/api/mwgl/eval-dataset`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}

/**
 * Top-K 多轮优化（默认 keep=2、初池=4）：DeepSeek 初池 + Qwen 内容/结构双路改写，返回全程最高分 workflow。
 */
export async function optimizeWorkflow({
  base,
  workflow,
  prompt,
  evalDataset,
  top4SearchMode = "beam"
}) {
  const root = String(base || "").trim().replace(/\/$/, "");
  const mode = String(top4SearchMode || "beam").toLowerCase() === "mcts" ? "mcts" : "beam";
  const body = {
    prompt: String(prompt || "").trim() || "MWGL 生成后优化",
    initial_workflow: workflow,
    eval_dataset: Array.isArray(evalDataset) ? evalDataset : [],
    graph_edit_eval: { enabled: true },
    config: {
      algorithm: "top4",
      mutation_mode: "llm_generate",
      top4_search_mode: mode,
      top4_keep: 2,
      top4_rounds: 2,
      top4_mcts_extra_rounds: 1,
      top4_mcts_exploration: 1.2,
      top4_initial_pool: 4,
      top4_children_per_parent: 2,
      eval_topk: 8
    }
  };

  const res = await fetch(`${root}/api/mwgl/optimize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`optimize 返回非 JSON：${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const diag =
      data?.diagnostics && typeof data.diagnostics === "object"
        ? ` [诊断] ${JSON.stringify(data.diagnostics)}`
        : "";
    throw new Error((data?.error || text.slice(0, 240)) + diag);
  }

  const best = data?.best_workflow;
  if (!best || typeof best !== "object") {
    throw new Error("optimize 未返回 best_workflow");
  }
  return normalizeWorkflow(best);
}

/** @deprecated 与 {@link optimizeWorkflow} 相同（已移除束搜索/MCTS） */
export async function optimizeWorkflowMcts(params) {
  return optimizeWorkflow(params);
}

export async function pseudoToCode({
  base,
  pseudocode,
  mainFlow = "",
  nodeFiles = null,
  language,
  workflow,
  mode = "regen",
  existingCode = "",
  revisionNotes = ""
}) {
  const body = {
    pseudocode,
    language,
    workflow,
    mode: mode === "incremental" ? "incremental" : "regen",
    existingCode,
    revisionNotes
  };
  if (mainFlow) body.mainFlow = mainFlow;
  if (nodeFiles && typeof nodeFiles === "object") body.nodeFiles = nodeFiles;

  const res = await fetch(`${base}/api/mwgl/code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = await res.json();
  return data?.content || "";
}

/** 根据 run-check 报错请 LLM 修复完整代码 */
export async function repairCodeFromCheck({
  base,
  code,
  language,
  checkResult,
  pseudocode,
  round = 1,
  maxRounds = 2
}) {
  const res = await fetch(`${base}/api/mwgl/code-repair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      language,
      checkResult,
      pseudocode: pseudocode || "",
      round,
      maxRounds
    })
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`API ${res.status}: ${text.slice(0, 240)}`);
  }
  if (!res.ok) {
    throw new Error(data?.error || data?.details?.join?.("; ") || `API ${res.status}`);
  }
  return data?.content || "";
}

export async function runCodeQuickCheck({ base, code, language }) {
  const res = await fetch(`${base}/api/mwgl/run-check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ code, language })
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`API ${res.status}: ${text.slice(0, 240)}`);
  }
  if (!res.ok) {
    throw new Error(data?.error || `API ${res.status}`);
  }
  return data;
}
