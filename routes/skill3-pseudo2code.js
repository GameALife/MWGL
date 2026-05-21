import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";
import { parseJsonResponse } from "../lib/mwgl-graph-utils.mjs";
import { summarizeNodeLoop } from "../lib/mwgl-loop-summary.mjs";
import { parseNodePseudoMap } from "../lib/mwgl-pseudo-parse.mjs";
import {
  assembleFullCode,
  needsNodeFunction
} from "../lib/mwgl-code-assembler.mjs";
import {
  CODE_INCR_SYSTEM,
  buildIncrementalCodeUserMessage
} from "../lib/mwgl-incremental-prompt.mjs";

const router = Router();

function stripMarkdownFence(text) {
  return String(text || "")
    .replace(/^```[\w-]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

const SYSTEM_PROMPT = `你是 MWGL v3 逐节点代码生成器。为每个工作流节点生成一个独立的函数片段。

## 输入
每个节点的 id、type、伪代码片段、loop 摘要（若有）、目标编程语言。主函数 main 只按主图顺序调用 node_*，不会在 main 里展开循环体；parallel 节点不需要生成函数。

## 输出
JSON：{ "节点id": "完整函数代码", ... }

## 函数规则（函数名 node_{id}，参数 ctx，返回 ctx）
- start：初始化 ctx
- step（无 loop）：执行业务逻辑，return ctx
- step（有 loop）：必须在函数内实现完整 for/while（按 loop.kind 与 loop.condition），循环体内按 loop.steps / 伪代码中的 FOR/WHILE 块实现 step/branch/subflow；不要只写注释代替循环
- branch：设置 ctx["branch"] 与出边 label 字符串完全一致，return ctx
- end：success → ctx["status"]="success"；failure → ctx["status"]="failure"
- parallel：不要为该节点生成函数（主函数对各臂并行调用子节点函数）

## 循环特别注意
- 循环挂在 step.loop，不是主图独立节点；循环内逻辑写在该 step 的 node_* 函数里，不要指望 main 再调用循环内步骤
- while：用 ctx["continue"] 或语言惯用写法表达是否继续；for：按 condition 写清迭代
- 嵌套 loop、循环内 branch：在函数内展开，保持可执行

## 格式
按目标语言写完整可执行函数；模拟数据 + TODO 中文注释；只输出 JSON，不要 markdown、不要代码块标记。`;

function formatNodeEntry(n, pseudoMap) {
  const parts = [`[${n.id}] type=${n.type}`];
  if (n.outcome) parts.push(`outcome=${n.outcome}`);
  const pseudo = pseudoMap[n.id] || n.text || "";
  if (pseudo) parts.push(`pseudo:\n${pseudo}`);
  const loopSum = summarizeNodeLoop(n);
  if (loopSum) parts.push(loopSum);
  return parts.join("\n");
}

async function generateNodeFunctions(workflow, pseudoMap, language, systemPrompt) {
  const codegenNodes = (workflow.nodes || []).filter(needsNodeFunction);
  const userMsg = [
    `## 目标语言：${language}`,
    "",
    "## 节点列表（含伪代码片段与 loop 摘要）",
    "",
    ...codegenNodes.map((n) => formatNodeEntry(n, pseudoMap))
  ].join("\n\n");

  const raw = await callDeepSeek(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg }
    ],
    0.3
  );
  return parseJsonResponse(raw);
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

    const workflow = req.body?.workflow;
    if (!workflow || !workflow.nodes) {
      return res.status(400).json({ error: "workflow is required" });
    }

    const language = String(req.body?.language || "Python").trim();
    const mode = String(req.body?.mode || "regen").trim();
    const existingCode = String(req.body?.existingCode || "").trim();
    const revisionNotes = String(req.body?.revisionNotes || "").trim();

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

    const pseudoMap = parseNodePseudoMap(pseudocode);

    let fnMap;
    try {
      fnMap = await generateNodeFunctions(workflow, pseudoMap, language, SYSTEM_PROMPT);
    } catch (error) {
      return res.status(422).json({
        error: "逐节点代码生成失败",
        details: error?.message || String(error)
      });
    }

    const content = assembleFullCode({ workflow, fnMap, language });
    res.json({ content });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: error?.message || "server error" });
  }
});

export default router;
