import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";
import { prepareNodeList } from "../lib/mwgl-graph-utils.mjs";
import {
  assembleMainFlow,
  buildNodePseudoContent,
  extractNodeDescFromLlmOutput,
  serializePseudocodeBundle
} from "../lib/mwgl-pseudo-assembler.mjs";
import { parsePseudocodeBundle } from "../lib/mwgl-pseudo-parse.mjs";
import {
  NODE_PSEUDO_SYSTEM,
  buildSingleNodePseudoUserMessage
} from "../lib/mwgl-pseudo-node-prompt.mjs";
import { PSEUDO_INCR_SYSTEM } from "../lib/mwgl-incremental-prompt.mjs";

const router = Router();

function stripMarkdownFence(text) {
  return String(text || "")
    .replace(/^```[\w-]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function polishNodePseudo(workflow, node, { existingPseudo = "", revisionNotes = "", incremental = false } = {}) {
  const system = incremental ? PSEUDO_INCR_SYSTEM : NODE_PSEUDO_SYSTEM;
  const userMsg = buildSingleNodePseudoUserMessage(workflow, node, { existingPseudo, revisionNotes });
  try {
    const raw = await callDeepSeek(
      [
        { role: "system", content: system },
        { role: "user", content: userMsg }
      ],
      0.2
    );
    return extractNodeDescFromLlmOutput(node, stripMarkdownFence(raw));
  } catch {
    return node.text || "";
  }
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

    const mode = String(req.body?.mode || "regen").trim();
    const existingPseudocode = String(req.body?.existingPseudocode || "").trim();
    const revisionNotes = String(req.body?.revisionNotes || "").trim();
    const incremental = mode === "incremental" && existingPseudocode;

    const existingBundle = incremental ? parsePseudocodeBundle(existingPseudocode) : { mainFlow: "", nodeFiles: {} };
    const nodeList = prepareNodeList(workflow);
    const descById = {};

    for (const entry of nodeList) {
      const node = (workflow.nodes || []).find((n) => n.id === entry.id);
      if (!node) continue;
      const existingBody = existingBundle.nodeFiles[node.id] || "";
      descById[node.id] = await polishNodePseudo(workflow, node, {
        existingPseudo: existingBody,
        revisionNotes: incremental ? revisionNotes : "",
        incremental
      });
    }

    const mainFlow = assembleMainFlow(workflow);
    const nodeFiles = {};
    for (const node of workflow.nodes || []) {
      nodeFiles[node.id] = buildNodePseudoContent(node, workflow, descById[node.id]);
    }

    const content = serializePseudocodeBundle({ mainFlow, nodeFiles });
    res.json({ content, mainFlow, nodeFiles });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: error?.message || "server error" });
  }
});

export default router;
