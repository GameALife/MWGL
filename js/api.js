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
 * 对已生成的工作流调用 `/api/mwgl/optimize`（束搜索或 MCTS；服务端仅使用 Qwen，需 QWEN_* 环境变量或显式 llm_mutator）。
 * @param {"beam"|"mcts"} algorithm
 * @returns {Promise<object>} best_workflow
 */
export async function optimizeWorkflow({
  base,
  workflow,
  prompt,
  evalDataset,
  algorithm = "mcts",
  iterations = 12
}) {
  const algo = String(algorithm || "mcts").toLowerCase();
  if (algo !== "beam" && algo !== "mcts") {
    throw new Error('algorithm 须为 "beam" 或 "mcts"');
  }
  const root = String(base || "").trim().replace(/\/$/, "");
  const it = Math.max(1, Math.floor(Number(iterations) || 12));
  const config =
    algo === "beam"
      ? {
          algorithm: "beam",
          iterations: it,
          beam_width: 4,
          candidates_per_parent: 4
        }
      : {
          algorithm: "mcts",
          iterations: it,
          beam_width: 6,
          candidates_per_parent: 4,
          mcts_exploration: 1.2,
          mcts_rollout_steps: 2
        };

  const res = await fetch(`${root}/api/mwgl/optimize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt: String(prompt || "").trim() || "MWGL 生成后优化",
      initial_workflow: workflow,
      eval_dataset: Array.isArray(evalDataset) ? evalDataset : [],
      config,
      evaluator: {
        url: `${root}/api/mwgl/mock-evaluator`,
        timeout_ms: 12000,
        pass_through_prompt: true
      }
    })
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

/** @deprecated 使用 {@link optimizeWorkflow} 并传 algorithm: "mcts" */
export async function optimizeWorkflowMcts(params) {
  return optimizeWorkflow({ ...params, algorithm: "mcts" });
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
