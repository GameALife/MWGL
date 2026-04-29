import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";

const router = Router();
const MAX_REPAIR_ROUNDS = Number(process.env.MWGL_PSEUDO_MAX_RETRY || 2);

const SYSTEM_PROMPT =
  "你是 MWGL v2 伪代码生成器。将工作流 JSON 转为结构化伪代码。只输出伪代码，不要 markdown/代码块/解释。\n\n" +
  "格式：缩进 2 空格，用关键字 BEGIN WORKFLOW / END WORKFLOW、STEP、IF / ELSE IF / ELSE、WHILE / END WHILE、PARALLEL / END PARALLEL（内含 BRANCH）、WAIT、SUCCESS、FAILURE。\n\n" +
  "映射：start→STEP, wait_user→WAIT, case→STEP, success→SUCCESS, failure→FAILURE。\n" +
  "switch→IF/ELSE IF/ELSE，出边 label 直接作为条件。loop_start/loop_end→WHILE/END WHILE，中间节点为循环体。parallel→PARALLEL，每条出边一个 BRANCH。\n\n" +
  "边：顺序连接；非 switch 的非空 label 以注释体现。从 start 按拓扑顺序展开。不可达节点末尾注释列出。";

function stripMarkdownFence(text) {
  return String(text || "")
    .replace(/^```[\w-]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function countKeywordLines(text, keyword) {
  const re = new RegExp(`^\\s*${keyword}\\b`, "gmi");
  return (text.match(re) || []).length;
}

function validatePseudocodeContent(content) {
  const cleaned = stripMarkdownFence(content);
  const errors = [];
  if (!cleaned) errors.push("伪代码为空。");
  if (!/^\s*BEGIN WORKFLOW\b/m.test(cleaned)) errors.push("缺少 BEGIN WORKFLOW。");
  if (!/^\s*END WORKFLOW\b/m.test(cleaned)) errors.push("缺少 END WORKFLOW。");

  const whileCount = countKeywordLines(cleaned, "WHILE");
  const endWhileCount = countKeywordLines(cleaned, "END WHILE");
  if (whileCount !== endWhileCount) errors.push("WHILE / END WHILE 数量不一致。");

  const parallelCount = countKeywordLines(cleaned, "PARALLEL");
  const endParallelCount = countKeywordLines(cleaned, "END PARALLEL");
  if (parallelCount !== endParallelCount) errors.push("PARALLEL / END PARALLEL 数量不一致。");

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
        previousText: checked.cleaned || stripMarkdownFence(content),
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
        error: "伪代码生成多次修复后仍未通过校验：你的要求可能过于单薄或过于复杂，请补充具体信息或精简要求。",
        details: checked.errors
      });
    }

    res.json({ content: checked.cleaned });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: error.message || "server error" });
  }
});

export default router;
