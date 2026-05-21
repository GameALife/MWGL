import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";
import { normalizeWorkflow, validateWorkflowConstraints } from "../js/mwgl.js";
import { MWGL_V3_GENERATE_SYSTEM_PROMPT } from "../lib/mwgl-generate-validate.mjs";

const router = Router();
const MAX_REPAIR_ROUNDS = Number(process.env.MWGL_GENERATE_MAX_RETRY || 3);

const SYSTEM_PROMPT = MWGL_V3_GENERATE_SYSTEM_PROMPT;

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
