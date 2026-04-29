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
 * 对已生成的工作流做 MCTS 优化（依赖同源的 optimize + mock-evaluator）。
 * @returns {Promise<object>} best_workflow
 */
export async function optimizeWorkflowMcts({
  base,
  workflow,
  prompt,
  evalDataset,
  iterations = 12
}) {
  const root = String(base || "").trim().replace(/\/$/, "");
  const res = await fetch(`${root}/api/mwgl/optimize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt: String(prompt || "").trim() || "MWGL 生成后优化",
      initial_workflow: workflow,
      eval_dataset: Array.isArray(evalDataset) ? evalDataset : [],
      config: {
        algorithm: "mcts",
        iterations: Math.max(1, Math.floor(Number(iterations) || 12)),
        beam_width: 6,
        candidates_per_parent: 4,
        mcts_exploration: 1.2,
        mcts_rollout_steps: 2
      },
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
    throw new Error(data?.error || text.slice(0, 240));
  }

  const best = data?.best_workflow;
  if (!best || typeof best !== "object") {
    throw new Error("optimize 未返回 best_workflow");
  }
  return normalizeWorkflow(best);
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
