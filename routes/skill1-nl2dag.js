import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";
import { normalizeWorkflow, validateWorkflowConstraints } from "../js/mwgl.js";

const router = Router();
const MAX_REPAIR_ROUNDS = Number(process.env.MWGL_GENERATE_MAX_RETRY || 3);

const SYSTEM_PROMPT =
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

function stripMarkdownFence(text) {
  return String(text || "")
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

function validateCandidateContent(content) {
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

function buildRepairPrompt({ originalPrompt, previousJson, errors, round, maxRounds }) {
  const errLines = (errors || []).map((e, i) => `${i + 1}) ${e}`).join("\n");
  return [
    `你上一次生成结果未通过校验。请在原需求基础上修复，并保持业务意图不变。`,
    `当前是第 ${round}/${maxRounds} 次修复。`,
    "",
    "原始用户需求：",
    originalPrompt,
    "",
    "上一版 JSON：",
    previousJson,
    "",
    "校验错误：",
    errLines,
    "",
    "请只输出修复后的完整 MWGL v3 JSON（mwgl_version:3）。"
  ].join("\n");
}

router.post("/api/mwgl/generate", async (req, res) => {
  try {
    if (!hasKey()) {
      return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY in server env." });
    }

    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) {
      return res.status(400).json({ error: "prompt is required" });
    }

    let content = await callDeepSeek([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt }
    ]);
    let checked = validateCandidateContent(content);

    for (let round = 1; round <= MAX_REPAIR_ROUNDS && !checked.ok; round += 1) {
      const repairPrompt = buildRepairPrompt({
        originalPrompt: prompt,
        previousJson: stripMarkdownFence(content),
        errors: checked.errors,
        round,
        maxRounds: MAX_REPAIR_ROUNDS
      });
      content = await callDeepSeek([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: repairPrompt }
      ]);
      checked = validateCandidateContent(content);
    }

    if (!checked.ok || !checked.normalized) {
      return res.status(422).json({
        error: "Generated workflow failed validation",
        details: checked.errors
      });
    }

    res.json({ content: JSON.stringify(checked.normalized, null, 2) });
  } catch (error) {
    res.status(500).json({ error: error?.message || "server error" });
  }
});

export default router;
