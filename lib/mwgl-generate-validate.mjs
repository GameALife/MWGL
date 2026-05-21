/**
 * 从自然语言 prompt 调用 DeepSeek 生成 MWGL v3 工作流并校验。
 */
import { callDeepSeek, hasKey } from "../routes/deepseek.js";
import { normalizeWorkflow, validateWorkflowConstraints } from "../js/mwgl.js";

export const MWGL_V3_GENERATE_SYSTEM_PROMPT =
  "你是 MWGL v3 编译器。把用户需求转成可通过校验的 JSON。只输出 JSON，无 markdown。\n" +
  "结构：{mwgl_version:3,rule_id,rule_name,nodes,edges}。\n" +
  "节点 type 仅：start | step | branch | end。\n" +
  "- start：唯一入口，无入边，≥1 出边。\n" +
  "- step：顺序动作，最多 1 条出边；文案用「动词+对象」。\n" +
  "- branch：条件分支，≥2 出边，每条出边 label 非空且不重复、有业务语义（禁纯数字/分支N）。\n" +
  "- end：终态无出边；须含 outcome: success | failure；failure 文案须具体（禁单独写「失败」）。\n" +
  "全图 DAG，无自环；从 start 可达的非 end 节点须能到达 end；至少一个可达 end。\n" +
  "循环：在 step 上使用 loop 对象：{ kind:\"for\"|\"while\", condition:string, steps:[] }；steps 项 type 为 step|loop|branch|subflow，可嵌套 for。\n" +
  "子工作流：subflow 步骤含 ref 指向 workflow.subworkflows 中的 DAG；主图 edges 仍保持 DAG，循环体不入主图。\n" +
  "edges 每项：id,from,to,label（非 branch 出发可为空）。\n" +
  "nodes 每项：id,type,text,x,y；type=end 时加 outcome。\n" +
  "优先生成节点少、可读性高的图；关键失败路径用 end outcome=failure 建模。";

export function stripMarkdownFence(text) {
  return String(text || "")
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

export function validateWorkflowFromLlmContent(content) {
  try {
    const parsed = JSON.parse(stripMarkdownFence(content));
    const normalized = normalizeWorkflow(parsed);
    const result = validateWorkflowConstraints(normalized);
    return {
      ok: result.ok,
      errors: result.errors || [],
      normalized
    };
  } catch (error) {
    return {
      ok: false,
      errors: [`返回内容不是合法 JSON：${error.message}`],
      normalized: null
    };
  }
}

export function temperaturesForCount(n) {
  const base = [0.2, 0.42, 0.62, 0.78, 0.55, 0.68, 0.35, 0.5];
  if (n <= base.length) return base.slice(0, n);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(0.25 + (0.55 * i) / Math.max(1, n - 1));
  return out;
}

/** @returns {Promise<{ ok: boolean, normalized: object|null, errors: string[], raw?: string }>} */
export async function generateWorkflowFromPrompt(prompt, temperature = 0.25, options = {}) {
  if (!hasKey()) {
    return { ok: false, normalized: null, errors: ["Missing DEEPSEEK_API_KEY"] };
  }
  const seedWorkflow = options?.seedWorkflow;
  let userContent = String(prompt || "").trim();
  if (seedWorkflow && typeof seedWorkflow === "object") {
    userContent +=
      "\n\n【用户已定稿的参照草图】请生成业务语义对齐、但拓扑或节点 id 不同的替代版本（勿原样复制）。" +
      "参照 JSON：\n" +
      JSON.stringify(seedWorkflow);
  }
  const raw = await callDeepSeek(
    [
      { role: "system", content: MWGL_V3_GENERATE_SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ],
    temperature
  );
  const checked = validateWorkflowFromLlmContent(raw);
  return { ...checked, raw };
}
