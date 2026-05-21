import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";
import {
  buildGraph,
  topoSort,
  reachableFromStart,
  findConvergence,
  parseJsonResponse,
  prepareNodeList
} from "../lib/mwgl-graph-utils.mjs";
import { appendLoopPseudoForNode } from "../js/mwgl-loop.js";
import { summarizeNodeLoop } from "../lib/mwgl-loop-summary.mjs";
import {
  PSEUDO_INCR_SYSTEM,
  buildIncrementalPseudoUserMessage
} from "../lib/mwgl-incremental-prompt.mjs";

const router = Router();

const SYSTEM_PROMPT = `你是 MWGL v3 伪代码文字润色器。

## 输入
你会收到一组工作流节点（已按拓扑排序），每个节点包含 id、type、原始 text、出边信息；带 loop 的 step 会附带 loop 摘要（kind/condition/steps）。

## 输出
一个 JSON 对象：key 为节点 id，value 为润色后的单行文字描述（不要换行）。

## 润色规则
- start：描述入口事件
- step（无 loop）：动宾结构，描述具体操作
- step（有 loop）：单行描述须点明循环业务目的，并呼应 loop.kind 与 loop.condition（例如 while「库存未补足且未超重试上限」）；不要在 JSON 中输出 FOR/WHILE/END 或展开 loop.steps（程序会按 loop.steps 确定性拼装）
- branch：描述判断内容（条件择一）
- parallel：描述并行业务目的（多臂同时执行）；各臂具体步骤由程序在 PARALLEL/ARM 块中展开，JSON 仍为单行
- end + outcome=success：成功终态
- end + outcome=failure：具体失败终态（禁单独写「失败」）

## 循环特别注意
- 循环体在 loop.steps 树中，不在主图 edges 里；不要为循环内子步骤单独生成 key
- 不要改写或省略 condition 的语义；kind=for 侧重迭代范围，kind=while 侧重持续条件

只输出 JSON 对象本身，不要 markdown、不要代码块标记、不要解释。`;

function assemblePseudocode(workflow, texts) {
  const { nodes, nodeMap, outEdges } = buildGraph(workflow);
  const subworkflows = workflow?.subworkflows || {};
  const topoOrder = topoSort(nodes, workflow?.edges || []);
  const topoIndex = new Map(topoOrder.map((id, i) => [id, i]));
  const reachable = reachableFromStart(nodes, outEdges);
  const start = nodes.find((n) => n.type === "start");

  const visited = new Set();
  const lines = [];
  const emit = (indent, text) => lines.push("  ".repeat(indent) + text);
  const getText = (id) => texts[id] || nodeMap.get(id)?.text || "未知";

  function traverse(nodeId, indent, stopBefore) {
    if (stopBefore && nodeId === stopBefore) return;
    if (visited.has(nodeId)) return;
    if (!nodeMap.has(nodeId) || !reachable.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    const outs = (outEdges.get(nodeId) || []).filter(
      (e) => nodeMap.has(e.to) && reachable.has(e.to)
    );
    const desc = getText(nodeId);

    switch (node.type) {
      case "start":
        emit(indent, `BEGIN WORKFLOW ${workflow.rule_name || "未命名"}  # [${node.id}] ${desc}`);
        for (const e of outs) traverse(e.to, indent + 1, null);
        emit(indent, "END WORKFLOW");
        break;

      case "step":
        emit(indent, `STEP  # [${node.id}] ${desc}`);
        if (node.loop) appendLoopPseudoForNode(node, subworkflows, lines, indent + 1);
        for (const e of outs) traverse(e.to, indent, stopBefore);
        break;

      case "branch": {
        const targets = outs.map((e) => e.to);
        const conv = findConvergence(targets, outEdges, nodeMap, topoIndex);
        emit(indent, `IF  # [${node.id}] ${desc}`);
        outs.forEach((e, i) => {
          const kw = i === 0 ? "IF" : "ELSE IF";
          emit(indent + 1, `${kw}  # [${e.id}] ${e.label || "条件"}`);
          traverse(e.to, indent + 2, conv);
        });
        emit(indent, "END IF");
        if (conv) traverse(conv, indent, stopBefore);
        break;
      }

      case "parallel": {
        const targets = outs.map((e) => e.to);
        const conv = findConvergence(targets, outEdges, nodeMap, topoIndex);
        emit(indent, `PARALLEL  # [${node.id}] ${desc}`);
        outs.forEach((e) => {
          emit(indent + 1, `ARM ${e.label || "臂"}  # [${e.id}]`);
          traverse(e.to, indent + 2, conv);
        });
        emit(indent, "END PARALLEL");
        if (conv) traverse(conv, indent, stopBefore);
        break;
      }

      case "end": {
        const kw = node.outcome === "failure" ? "FAILURE" : "SUCCESS";
        emit(indent, `${kw}  # [${node.id}] ${desc}`);
        break;
      }

      default:
        emit(indent, `STEP  # [${node.id}] ${desc}`);
        for (const e of outs) traverse(e.to, indent, stopBefore);
    }
  }

  if (start) traverse(start.id, 0, null);

  const unreachable = nodes.filter((n) => !reachable.has(n.id));
  if (unreachable.length) {
    lines.push("");
    lines.push("# 不可达节点（草稿，不参与执行）");
    for (const n of unreachable) {
      lines.push(`# [${n.id}] ${n.type}: ${getText(n.id)}`);
    }
  }

  return lines.join("\n");
}

function buildNodeListUserMessage(workflow, nodeList) {
  const nodeMap = new Map((workflow?.nodes || []).map((n) => [n.id, n]));
  let userMsg = "## 工作流节点列表（已拓扑排序）\n\n";
  userMsg += "| 序号 | 节点ID | 类型 | 原始描述 | 出边 |\n";
  userMsg += "|------|--------|------|----------|------|\n";
  nodeList.forEach((n, i) => {
    const outStr = n.outEdges.length
      ? n.outEdges.map((e) => `→ ${e.to}(${e.label || "无标签"})`).join(", ")
      : "无";
    const extra = n.outcome ? ` outcome=${n.outcome}` : n.hasLoop ? " loop=是" : "";
    userMsg += `| ${i + 1} | ${n.id} | ${n.type}${extra} | ${n.text || ""} | ${outStr} |\n`;
  });

  const loopNodes = nodeList.filter((n) => n.hasLoop);
  if (loopNodes.length) {
    userMsg += "\n## 含循环的节点（loop 摘要，供润色 step 单行描述时参考）\n\n";
    for (const n of loopNodes) {
      const full = nodeMap.get(n.id);
      userMsg += `### [${n.id}]\n${summarizeNodeLoop(full)}\n\n`;
    }
  }

  userMsg += `## 原始工作流 JSON\n${JSON.stringify(workflow, null, 2)}`;
  return userMsg;
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

    const nodeList = prepareNodeList(workflow);
    const nodeTableMsg = buildNodeListUserMessage(workflow, nodeList);

    const incremental = mode === "incremental" && existingPseudocode;
    const systemPrompt = incremental ? PSEUDO_INCR_SYSTEM : SYSTEM_PROMPT;
    const userMsg = incremental
      ? buildIncrementalPseudoUserMessage({
          workflow,
          existingPseudocode,
          revisionNotes,
          nodeListUserMsg: nodeTableMsg
        })
      : nodeTableMsg;

    let enhancedTexts;
    try {
      const raw = await callDeepSeek([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg }
      ]);
      enhancedTexts = parseJsonResponse(raw);
    } catch {
      enhancedTexts = {};
      for (const n of workflow.nodes) enhancedTexts[n.id] = n.text;
    }

    const content = assemblePseudocode(workflow, enhancedTexts);
    res.json({ content });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: error?.message || "server error" });
  }
});

export default router;
