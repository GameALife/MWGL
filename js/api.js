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

export async function dagToPseudocode({ base, workflow }) {
  const res = await fetch(`${base}/api/mwgl/pseudocode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ workflow })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = await res.json();
  return data?.content || "";
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
 * Top-4 多轮优化：DeepSeek 初池 + Qwen 整图改写，返回全程最高分 workflow。
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
    config: {
      algorithm: "top4",
      mutation_mode: "llm_generate",
      top4_search_mode: mode,
      top4_keep: 4,
      top4_rounds: 2,
      top4_mcts_extra_rounds: 1,
      top4_mcts_exploration: 1.2,
      top4_initial_pool: 8,
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

export async function pseudoToCode({ base, pseudocode, language }) {
  const res = await fetch(`${base}/api/mwgl/code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ pseudocode, language })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = await res.json();
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
