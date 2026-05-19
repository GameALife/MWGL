import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";

const router = Router();
const MAX_REPAIR_ROUNDS = Number(process.env.MWGL_PSEUDO_MAX_RETRY || 2);

const SYSTEM_PROMPT =
  "你是 MWGL v3 伪代码生成器。将工作流 JSON 转为结构化伪代码。只输出伪代码，不要 markdown。\n\n" +
  "格式：BEGIN WORKFLOW / END WORKFLOW；STEP；IF / ELSE IF / ELSE（条件来自 branch 出边 label）；END（success/failure 来自 end.outcome）。\n\n" +
  "映射：start→STEP；step→STEP；branch→IF/ELSE IF/ELSE；end outcome=success→SUCCESS；end outcome=failure→FAILURE。\n" +
  "从 start 按拓扑展开。若 step 含 loop 对象：按 loop.kind/condition 输出 FOR/WHILE 块，递归展开 loop.steps（含嵌套 loop、branch 各 arm、subflow 引用注释）。主图 edges 仍为 DAG。";

function stripMarkdownFence(text) {
  return String(text || "")
    .replace(/^```[\w-]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function validatePseudocodeContent(content) {
  const cleaned = stripMarkdownFence(content);
  const errors = [];
  if (!cleaned) errors.push("伪代码为空。");
  if (!/^\s*BEGIN WORKFLOW\b/m.test(cleaned)) errors.push("缺少 BEGIN WORKFLOW。");
  if (!/^\s*END WORKFLOW\b/m.test(cleaned)) errors.push("缺少 END WORKFLOW。");
  return { ok: errors.length === 0, errors, cleaned };
}

function buildRepairPrompt({ workflow, previousText, errors, round, maxRounds }) {
  const errLines = errors.map((e, i) => `${i + 1}) ${e}`).join("\n");
  return [
    `你上一次输出的伪代码未通过格式校验。请在保持语义不变的前提下修复。`,
    `当前是第 ${round}/${maxRounds} 次修复。`,
    "",
    "工作流 JSON：",
    JSON.stringify(workflow, null, 2),
    "",
    "上一版伪代码：",
    previousText,
    "",
    "校验错误：",
    errLines,
    "",
    "请只输出修复后的完整伪代码。"
  ].join("\n");
}

router.post("/api/mwgl/pseudocode", async (req, res) => {
  try {
    if (!hasKey()) {
      return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY in server env." });
    }

    const workflow = req.body?.workflow;
    if (!workflow || !workflow.nodes) {
      return res.status(400).json({ error: "workflow with nodes is required" });
    }

    let content = await callDeepSeek([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(workflow, null, 2) }
    ]);
    let checked = validatePseudocodeContent(content);

    for (let round = 1; round <= MAX_REPAIR_ROUNDS && !checked.ok; round += 1) {
      const repairPrompt = buildRepairPrompt({
        workflow,
        previousText: stripMarkdownFence(content),
        errors: checked.errors,
        round,
        maxRounds: MAX_REPAIR_ROUNDS
      });
      content = await callDeepSeek([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: repairPrompt }
      ]);
      checked = validatePseudocodeContent(content);
    }

    if (!checked.ok) {
      return res.status(422).json({
        error: "Pseudocode validation failed",
        details: checked.errors
      });
    }

    res.json({ content: checked.cleaned });
  } catch (error) {
    res.status(500).json({ error: error?.message || "server error" });
  }
});

export default router;
