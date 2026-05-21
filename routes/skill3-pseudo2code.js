import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";
import { parseNodePseudoMap, parsePseudocodeBundle } from "../lib/mwgl-pseudo-parse.mjs";
import {
  assembleFullCode,
  needsNodeFunction
} from "../lib/mwgl-code-assembler.mjs";
import {
  CODE_INCR_SYSTEM,
  buildIncrementalCodeUserMessage
} from "../lib/mwgl-incremental-prompt.mjs";
import {
  NODE_CODE_SYSTEM,
  buildSingleNodeCodeUserMessage
} from "../lib/mwgl-pseudo-node-prompt.mjs";

const router = Router();

function stripMarkdownFence(text) {
  return String(text || "")
    .replace(/^```[\w-]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function generateOneNodeFunction(node, pseudo, language, systemPrompt) {
  const userMsg = buildSingleNodeCodeUserMessage(node, pseudo, language);
  const raw = await callDeepSeek(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg }
    ],
    0.3
  );
  return stripMarkdownFence(raw);
}

async function generateNodeFunctionsSequential(workflow, pseudoMap, language, systemPrompt) {
  const fnMap = {};
  const codegenNodes = (workflow.nodes || []).filter(needsNodeFunction);

  for (const node of codegenNodes) {
    const pseudo = pseudoMap[node.id] || node.text || "";
    try {
      fnMap[node.id] = await generateOneNodeFunction(node, pseudo, language, systemPrompt);
    } catch {
      fnMap[node.id] = "";
    }
  }
  return fnMap;
}

router.post("/api/mwgl/code", async (req, res) => {
  try {
    if (!hasKey()) {
      return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY in server env." });
    }

    const pseudocode = String(req.body?.pseudocode || "").trim();
    const bodyNodeFiles = req.body?.nodeFiles;
    const bodyMainFlow = String(req.body?.mainFlow || "").trim();

    if (!pseudocode && !bodyNodeFiles) {
      return res.status(400).json({ error: "pseudocode or nodeFiles is required" });
    }

    const workflow = req.body?.workflow;
    if (!workflow || !workflow.nodes) {
      return res.status(400).json({ error: "workflow is required" });
    }

    const language = String(req.body?.language || "Python").trim();
    const mode = String(req.body?.mode || "regen").trim();
    const existingCode = String(req.body?.existingCode || "").trim();
    const revisionNotes = String(req.body?.revisionNotes || "").trim();

    const bundle = parsePseudocodeBundle(pseudocode);
    const pseudoMap =
      bodyNodeFiles && typeof bodyNodeFiles === "object"
        ? bodyNodeFiles
        : Object.keys(bundle.nodeFiles).length
          ? bundle.nodeFiles
          : parseNodePseudoMap(pseudocode);

    if (mode === "incremental" && existingCode) {
      const incrMsg = buildIncrementalCodeUserMessage({
        language,
        existingCode,
        pseudocode,
        workflow,
        revisionNotes
      });
      const content = await callDeepSeek(
        [
          { role: "system", content: CODE_INCR_SYSTEM },
          { role: "user", content: incrMsg }
        ],
        0.25
      );
      const cleaned = stripMarkdownFence(content);
      if (!cleaned || cleaned.length < 20) {
        return res.status(422).json({ error: "增量代码输出过短或无效" });
      }
      return res.json({ content: cleaned });
    }

    let fnMap;
    try {
      fnMap = await generateNodeFunctionsSequential(workflow, pseudoMap, language, NODE_CODE_SYSTEM);
    } catch (error) {
      return res.status(422).json({
        error: "逐节点代码生成失败",
        details: error?.message || String(error)
      });
    }

    const content = assembleFullCode({ workflow, fnMap, language });
    res.json({
      content,
      mainFlow: bodyMainFlow || bundle.mainFlow || ""
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: error?.message || "server error" });
  }
});

export default router;
