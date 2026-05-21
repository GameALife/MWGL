import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";
import {
  buildGraph,
  topoSort,
  reachableFromStart,
  findConvergence,
  parseJsonResponse,
  safeFn
} from "../lib/mwgl-graph-utils.mjs";
import { summarizeNodeLoop } from "../lib/mwgl-loop-summary.mjs";
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
每个节点的 id、type、伪代码片段、loop 摘要（若有）、目标编程语言。主函数 main 只按主图顺序调用 node_*，不会在 main 里展开循环体。

## 输出
JSON：{ "节点id": "完整函数代码", ... }

## 函数规则（函数名 node_{id}，参数 ctx，返回 ctx）
- start：初始化 ctx
- step（无 loop）：执行业务逻辑，return ctx
- step（有 loop）：必须在函数内实现完整 for/while（按 loop.kind 与 loop.condition），循环体内按 loop.steps / 伪代码中的 FOR/WHILE 块实现 step/branch/subflow；不要只写注释代替循环
- branch：设置 ctx["branch"] 与出边 label 字符串完全一致，return ctx
- end：success → ctx["status"]="success"；failure → ctx["status"]="failure"

## 循环特别注意
- 循环挂在 step.loop，不是主图独立节点；循环内逻辑写在该 step 的 node_* 函数里，不要指望 main 再调用循环内步骤
- while：用 ctx["continue"] 或语言惯用写法表达是否继续；for：按 condition 写清迭代
- 嵌套 loop、循环内 branch：在函数内展开，保持可执行

## 格式
按目标语言写完整可执行函数；模拟数据 + TODO 中文注释；只输出 JSON，不要 markdown、不要代码块标记。`;

const LANG = {
  Python: {
    indent: 4,
    comment: "#",
    imports: "import asyncio\n",
    def: (fn) => `async def ${fn}(ctx):`,
    endDef: "",
    call: (fn, sp) => `${sp}ctx = await ${fn}(ctx)`,
    callSwitch: (fn, sp) => `${sp}branch = await ${fn}(ctx)`,
    ifStart: (cond, sp) => `${sp}if branch == "${cond}":`,
    elif: (cond, sp) => `${sp}elif branch == "${cond}":`,
    success: (fn, sp) => `${sp}return await ${fn}(ctx)`,
    failure: (fn, sp) => `${sp}await ${fn}(ctx)\n${sp}return`,
    mainStart: "async def main():",
    mainCtx: (sp) => `${sp}ctx = {}`,
    mainEnd: "",
    footer: "\nasyncio.run(main())"
  },
  JavaScript: {
    indent: 2,
    comment: "//",
    imports: "",
    def: (fn) => `async function ${fn}(ctx) {`,
    endDef: "}",
    call: (fn, sp) => `${sp}ctx = await ${fn}(ctx);`,
    callSwitch: (fn, sp) => `${sp}const branch = await ${fn}(ctx);`,
    ifStart: (cond, sp) => `${sp}if (branch === "${cond}") {`,
    elif: (cond, sp) => `${sp}} else if (branch === "${cond}") {`,
    blockEnd: (sp) => `${sp}}`,
    success: (fn, sp) => `${sp}return await ${fn}(ctx);`,
    failure: (fn, sp) => `${sp}await ${fn}(ctx);\n${sp}return;`,
    mainStart: "async function main() {",
    mainCtx: (sp) => `${sp}let ctx = {};`,
    mainEnd: "}",
    footer: "\nmain();"
  },
  Go: {
    indent: 2,
    comment: "//",
    imports: 'import "fmt"\n',
    def: (fn) => `func ${fn}(ctx map[string]interface{}) map[string]interface{} {`,
    endDef: "}",
    call: (fn, sp) => `${sp}ctx = ${fn}(ctx)`,
    callSwitch: (fn, sp) => `${sp}branch := fmt.Sprint(${fn}(ctx)["branch"])`,
    ifStart: (cond, sp) => `${sp}if branch == "${cond}" {`,
    elif: (cond, sp) => `${sp}} else if branch == "${cond}" {`,
    blockEnd: (sp) => `${sp}}`,
    success: (fn, sp) => `${sp}${fn}(ctx)\n${sp}return`,
    failure: (fn, sp) => `${sp}${fn}(ctx)\n${sp}return`,
    mainStart: "func main() {",
    mainCtx: (sp) => `${sp}ctx := map[string]interface{}{}`,
    mainEnd: "}",
    footer: ""
  },
  Java: {
    indent: 2,
    comment: "//",
    imports: "import java.util.*;\n",
    def: (fn) => `static Map<String, Object> ${fn}(Map<String, Object> ctx) {`,
    endDef: "}",
    call: (fn, sp) => `${sp}ctx = ${fn}(ctx);`,
    callSwitch: (fn, sp) => `${sp}String branch = (String) ${fn}(ctx).get("branch");`,
    ifStart: (cond, sp) => `${sp}if ("${cond}".equals(branch)) {`,
    elif: (cond, sp) => `${sp}} else if ("${cond}".equals(branch)) {`,
    blockEnd: (sp) => `${sp}}`,
    success: (fn, sp) => `${sp}${fn}(ctx); return;`,
    failure: (fn, sp) => `${sp}${fn}(ctx); return;`,
    mainStart: "  public static void main(String[] args) {",
    mainCtx: (sp) => `${sp}Map<String, Object> ctx = new HashMap<>();`,
    mainEnd: "  }",
    footer: "",
    classWrap: true,
    className: "WorkflowApp"
  },
  "C++": {
    indent: 2,
    comment: "//",
    imports: "#include <iostream>\n#include <map>\n#include <string>\nusing namespace std;\n",
    def: (fn) => `map<string, string> ${fn}(map<string, string> ctx) {`,
    endDef: "}",
    call: (fn, sp) => `${sp}ctx = ${fn}(ctx);`,
    callSwitch: (fn, sp) => `${sp}string branch = ${fn}(ctx)["branch"];`,
    ifStart: (cond, sp) => `${sp}if (branch == "${cond}") {`,
    elif: (cond, sp) => `${sp}} else if (branch == "${cond}") {`,
    blockEnd: (sp) => `${sp}}`,
    success: (fn, sp) => `${sp}${fn}(ctx); return 0;`,
    failure: (fn, sp) => `${sp}${fn}(ctx); return 1;`,
    mainStart: "int main() {",
    mainCtx: (sp) => `${sp}map<string, string> ctx;`,
    mainEnd: "}",
    footer: ""
  }
};

function parseNodePseudoMap(pseudocode) {
  const map = {};
  const blocks = pseudocode.split(/---\s+(\S+)\.pseudo\s*---/);
  if (blocks.length > 1) {
    for (let i = 1; i < blocks.length; i += 2) {
      map[blocks[i]] = blocks[i + 1].trim();
    }
    return map;
  }

  let currentId = null;
  let buf = [];
  const flush = () => {
    if (currentId) map[currentId] = buf.join("\n").trim();
    buf = [];
  };

  for (const line of pseudocode.split("\n")) {
    const m = line.match(/#\s*\[([^\]]+)\]/);
    if (m) {
      flush();
      currentId = m[1];
      const rest = line.replace(/^.*?#\s*\[[^\]]+\]\s*/, "").trim();
      if (rest) buf.push(rest);
      continue;
    }
    if (currentId) buf.push(line);
  }
  flush();
  return map;
}

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
  const userMsg = [
    `## 目标语言：${language}`,
    "",
    "## 节点列表（含伪代码片段与 loop 摘要）",
    "",
    ...(workflow.nodes || []).map((n) => formatNodeEntry(n, pseudoMap))
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

function assembleMainFromFlow(workflow, language) {
  const lang = LANG[language] || LANG.Python;
  const W = lang.indent;
  const { nodes, nodeMap, outEdges } = buildGraph(workflow);
  const topoOrder = topoSort(nodes, workflow?.edges || []);
  const topoIndex = new Map(topoOrder.map((id, i) => [id, i]));
  const reachable = reachableFromStart(nodes, outEdges);
  const start = nodes.find((n) => n.type === "start");

  const visited = new Set();
  const lines = [];
  const sp = (level) => " ".repeat(level * W);

  function traverse(nodeId, level, stopBefore) {
    if (stopBefore && nodeId === stopBefore) return;
    if (visited.has(nodeId)) return;
    if (!nodeMap.has(nodeId) || !reachable.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    const outs = (outEdges.get(nodeId) || []).filter(
      (e) => nodeMap.has(e.to) && reachable.has(e.to)
    );
    const fn = safeFn(nodeId);
    const s = sp(level);

    switch (node.type) {
      case "start":
        lines.push(lang.call(fn, s));
        for (const e of outs) traverse(e.to, level, stopBefore);
        break;

      case "step":
        lines.push(lang.call(fn, s));
        for (const e of outs) traverse(e.to, level, stopBefore);
        break;

      case "branch": {
        const conv = findConvergence(
          outs.map((e) => e.to),
          outEdges,
          nodeMap,
          topoIndex
        );
        lines.push(lang.callSwitch(fn, s));
        outs.forEach((e, i) => {
          lines.push((i === 0 ? lang.ifStart : lang.elif)(e.label || `branch_${i}`, s));
          traverse(e.to, level + 1, conv);
        });
        if (lang.blockEnd) lines.push(lang.blockEnd(s));
        if (conv) traverse(conv, level, stopBefore);
        break;
      }

      case "end":
        if (node.outcome === "failure") lines.push(lang.failure(fn, s));
        else lines.push(lang.success(fn, s));
        break;

      default:
        lines.push(lang.call(fn, s));
        for (const e of outs) traverse(e.to, level, stopBefore);
    }
  }

  const mainLines = [];
  mainLines.push(lang.mainStart);
  mainLines.push(lang.mainCtx(sp(1)));
  if (start) traverse(start.id, 1, null);
  if (lang.mainEnd) mainLines.push(lang.mainEnd);
  return mainLines.join("\n");
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
      return res.status(400).json({ error: "workflow with nodes is required" });
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

    const lang = LANG[language] || LANG.Python;
    const mainFunction = assembleMainFromFlow(workflow, language);
    const parts = [];

    if (lang.classWrap) parts.push(`public class ${lang.className} {`);
    if (lang.imports) parts.push(lang.imports);

    parts.push(`${lang.comment} ========== 逐节点函数 ==========`);
    parts.push("");
    for (const node of workflow.nodes) {
      const code = fnMap[node.id];
      if (!code) continue;
      parts.push(lang.classWrap ? code.split("\n").map((l) => "  " + l).join("\n") : code);
      parts.push("");
    }

    parts.push(`${lang.comment} ========== 主函数（按图结构自动拼装） ==========`);
    parts.push("");
    parts.push(mainFunction);
    if (lang.footer) parts.push(lang.classWrap ? "  " + lang.footer.trim() : lang.footer);
    if (lang.classWrap) parts.push("}");

    res.json({ content: parts.join("\n") });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: error?.message || "server error" });
  }
});

export default router;
