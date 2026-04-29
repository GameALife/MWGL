import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";

const router = Router();
const MAX_REPAIR_ROUNDS = Number(process.env.MWGL_CODE_MAX_RETRY || 2);

const SYSTEM_PROMPT =
  "你是代码生成器。将结构化伪代码转为可执行的真实代码。只输出代码，不要 markdown/代码块标记/解释。\n\n" +
  "关键字映射：BEGIN/END WORKFLOW→函数入口，STEP→语句，IF/ELSE IF/ELSE→条件，WHILE/END WHILE→循环，PARALLEL/END PARALLEL→并发（BRANCH→分支体），WAIT→用户输入，SUCCESS→正常返回，FAILURE→错误返回。\n\n" +
  "要求：完整可执行含 import，保留变量名定义，只输出可直接复制运行的可执行代码，关键步骤加中文注释。默认 Python，用户指定则用对应语言。";

function stripMarkdownFence(text) {
  return String(text || "")
    .replace(/^```[\w-]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function validateCodeContent(content) {
  const cleaned = stripMarkdownFence(content);
  const errors = [];
  if (!cleaned) errors.push("代码为空。");
  if (/```/.test(String(content || ""))) errors.push("输出包含 Markdown 代码块标记。");
  if (cleaned.length < 20) errors.push("代码内容过短，疑似无效输出。");
  return { ok: errors.length === 0, errors, cleaned };
}

function buildRepairPrompt({ pseudocode, language, previousCode, errors, round, maxRounds }) {
  const errLines = errors.map((e, i) => `${i + 1}) ${e}`).join("\n");
  return [
    `你上一次输出的代码未通过格式校验。请在保持语义不变前提下修复。`,
    `当前是第 ${round}/${maxRounds} 次修复。`,
    "",
    `目标语言：${language}`,
    "",
    "输入伪代码：",
    pseudocode,
    "",
    "上一版代码：",
    previousCode,
    "",
    "校验错误：",
    errLines,
    "",
    "请只输出修复后的完整可执行代码。"
  ].join("\n");
}

router.post("/api/mwgl/code", async (req, res) => {
  try {
    if (!hasKey()) {
      return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY in server env." });
    }

    const pseudocode = String(req.body?.pseudocode || "").trim();
    if (!pseudocode) {
      return res.status(400).json({ error: "pseudocode is required" });
    }

    const language = String(req.body?.language || "Python").trim();
    let userMessage = `目标语言：${language}\n\n${pseudocode}`;
    let content = await callDeepSeek([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage }
    ]);
    let checked = validateCodeContent(content);

    for (let round = 1; round <= MAX_REPAIR_ROUNDS && !checked.ok; round += 1) {
      userMessage = buildRepairPrompt({
        pseudocode,
        language,
        previousCode: checked.cleaned || stripMarkdownFence(content),
        errors: checked.errors,
        round,
        maxRounds: MAX_REPAIR_ROUNDS
      });
      content = await callDeepSeek([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage }
      ]);
      checked = validateCodeContent(content);
    }

    if (!checked.ok) {
      return res.status(422).json({
        error: "代码生成多次修复后仍未通过校验：你的要求可能过于单薄或过于复杂，请补充具体信息或精简要求。",
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
