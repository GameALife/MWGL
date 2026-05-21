import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";

const router = Router();

const REPAIR_SYSTEM_PROMPT = `你是 MWGL 工作流代码修复器。根据运行检测或语法报错，修复完整可执行代码。

## 要求
- 只输出修复后的完整代码，不要 markdown 代码块，不要解释
- 保持目标语言语法正确，保留 node_* 函数 + main 入口的整体结构
- 针对 stderr/语法错误逐条修复，不要删除未报错的核心逻辑
- 保留中文 TODO 注释；模拟数据可微调以保证能运行
- Python 若含 asyncio：确保 import asyncio 且 main 可被脚本方式执行
- JavaScript 若含 top-level await：使用 .mjs 兼容写法或包在 async main 中`;

function stripMarkdownFence(text) {
  return String(text || "")
    .replace(/^```[\w-]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function formatCheckFeedback(checkResult) {
  const checks = Array.isArray(checkResult?.checks) ? checkResult.checks : [];
  const lines = [
    `exitCode: ${checkResult?.exitCode ?? "?"}`,
    `syntaxOk: ${checkResult?.syntaxOk ?? "?"}`,
    "",
    "检查项:",
    ...checks.map((c, i) => `${i + 1}) [${c.ok ? "OK" : "FAIL"}] ${c.name}: ${c.detail || ""}`),
    "",
    "stderr:",
    String(checkResult?.stderr || "").trim() || "(empty)",
    "",
    "stdout:",
    String(checkResult?.stdout || "").trim() || "(empty)"
  ];
  return lines.join("\n");
}

function buildRepairUserMessage({
  code,
  language,
  pseudocode,
  checkResult,
  round,
  maxRounds
}) {
  const parts = [
    `目标语言：${language}`,
    `当前是第 ${round}/${maxRounds} 次修复。`,
    "",
    "## 运行检测反馈",
    formatCheckFeedback(checkResult),
    ""
  ];
  if (pseudocode?.trim()) {
    parts.push("## 参考伪代码（保持业务语义一致）", pseudocode.trim().slice(0, 12000), "");
  }
  parts.push("## 待修复的完整代码", code);
  parts.push("", "请输出修复后的完整代码。");
  return parts.join("\n");
}

router.post("/api/mwgl/code-repair", async (req, res) => {
  try {
    if (!hasKey()) {
      return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY in server env." });
    }

    const code = String(req.body?.code || "").trim();
    const language = String(req.body?.language || "Python").trim();
    const checkResult = req.body?.checkResult || req.body?.check || null;
    const pseudocode = String(req.body?.pseudocode || "").trim();
    const round = Number(req.body?.round || 1);
    const maxRounds = Number(req.body?.maxRounds || process.env.MWGL_CODE_REPAIR_MAX_RETRY || 2);

    if (!code) return res.status(400).json({ error: "code is required" });
    if (!checkResult) {
      return res.status(400).json({ error: "checkResult is required (run-check response)" });
    }

    const userMessage = buildRepairUserMessage({
      code,
      language,
      pseudocode,
      checkResult,
      round,
      maxRounds
    });

    const content = await callDeepSeek(
      [
        { role: "system", content: REPAIR_SYSTEM_PROMPT },
        { role: "user", content: userMessage }
      ],
      0.15
    );

    const cleaned = stripMarkdownFence(content);
    if (!cleaned || cleaned.length < 20) {
      return res.status(422).json({
        error: "repair output too short or empty",
        details: ["模型未返回有效代码"]
      });
    }

    res.json({ content: cleaned, round });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: error?.message || "code repair failed" });
  }
});

export default router;
