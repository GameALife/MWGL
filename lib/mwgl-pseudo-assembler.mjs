import {
  buildGraph,
  topoSort,
  reachableFromStart,
  findConvergence
} from "./mwgl-graph-utils.mjs";
import { appendLoopPseudoForNode } from "../js/mwgl-loop.js";
import { serializePseudocodeBundle } from "./mwgl-pseudo-parse.mjs";

export { serializePseudocodeBundle };

/**
 * 确定性生成 main.flow（只描述怎么串，不含节点业务文案）。
 * 结构与 assembleMainFromFlow 遍历一致，供 Skill3 主函数骨架对照。
 */
export function assembleMainFlow(workflow) {
  const { nodes, nodeMap, outEdges } = buildGraph(workflow);
  const topoOrder = topoSort(nodes, workflow?.edges || []);
  const topoIndex = new Map(topoOrder.map((id, i) => [id, i]));
  const reachable = reachableFromStart(nodes, outEdges);
  const start = nodes.find((n) => n.type === "start");

  const visited = new Set();
  const lines = [];
  const emit = (indent, text) => lines.push("  ".repeat(indent) + text);

  function traverse(nodeId, indent, stopBefore) {
    if (stopBefore && nodeId === stopBefore) return;
    if (visited.has(nodeId)) return;
    if (!nodeMap.has(nodeId) || !reachable.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    const outs = (outEdges.get(nodeId) || []).filter(
      (e) => nodeMap.has(e.to) && reachable.has(e.to)
    );

    switch (node.type) {
      case "start":
        emit(indent, `BEGIN WORKFLOW ${workflow.rule_name || "未命名"}`);
        emit(indent + 1, `CALL ${node.id}`);
        for (const e of outs) traverse(e.to, indent + 1, null);
        emit(indent, "END WORKFLOW");
        break;

      case "step":
        emit(indent, `CALL ${node.id}`);
        for (const e of outs) traverse(e.to, indent, stopBefore);
        break;

      case "branch": {
        const targets = outs.map((e) => e.to);
        const conv = findConvergence(targets, outEdges, nodeMap, topoIndex);
        emit(indent, `IF ${node.id}`);
        outs.forEach((e, i) => {
          const kw = i === 0 ? "BRANCH" : "ELSE";
          emit(indent + 1, `${kw} ${e.label || "条件"}  # [${e.id}]`);
          traverse(e.to, indent + 2, conv);
        });
        emit(indent, "END IF");
        if (conv) traverse(conv, indent, stopBefore);
        break;
      }

      case "parallel": {
        const targets = outs.map((e) => e.to);
        const conv = findConvergence(targets, outEdges, nodeMap, topoIndex);
        emit(indent, `PARALLEL ${node.id}`);
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
        emit(indent, `${kw} ${node.id}`);
        break;
      }

      default:
        emit(indent, `CALL ${node.id}`);
        for (const e of outs) traverse(e.to, indent, stopBefore);
    }
  }

  if (start) traverse(start.id, 0, null);

  const unreachable = nodes.filter((n) => !reachable.has(n.id));
  if (unreachable.length) {
    lines.push("");
    lines.push("# 不可达节点（草稿，不参与执行）");
    for (const n of unreachable) {
      lines.push(`# ${n.id} (${n.type})`);
    }
  }

  return lines.join("\n");
}

/** 单节点 .pseudo 正文（做什么；含循环体确定性展开）。 */
export function buildNodePseudoContent(node, workflow, descText) {
  const subworkflows = workflow?.subworkflows || {};
  const desc = String(descText || node.text || "").trim();
  const lines = [];

  switch (node.type) {
    case "start":
      lines.push(`BEGIN ${desc}`);
      break;
    case "step":
      lines.push(`STEP ${desc}`);
      if (node.loop) {
        const loopLines = [];
        appendLoopPseudoForNode(node, subworkflows, loopLines, 0);
        lines.push(...loopLines);
      }
      break;
    case "branch":
      lines.push(`IF ${desc}`);
      break;
    case "parallel":
      lines.push(`PARALLEL ${desc}`);
      break;
    case "end":
      lines.push(`${node.outcome === "failure" ? "FAILURE" : "SUCCESS"} ${desc}`);
      break;
    default:
      lines.push(`STEP ${desc}`);
  }

  return lines.join("\n");
}

/** @returns {Record<string, string>} */
export function buildAllNodePseudoFiles(workflow, descById) {
  const { nodes } = buildGraph(workflow);
  const files = {};
  for (const node of nodes) {
    const desc = descById?.[node.id] ?? node.text ?? "";
    files[node.id] = buildNodePseudoContent(node, workflow, desc);
  }
  return files;
}

/** 从 LLM 单节点输出提取首行描述（STEP/IF/… 后的文案或整行）。 */
export function extractNodeDescFromLlmOutput(node, raw) {
  const text = String(raw || "").trim();
  if (!text) return node.text || "";

  const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean) || "";
  const prefixes = ["BEGIN", "STEP", "IF", "PARALLEL", "SUCCESS", "FAILURE"];
  for (const p of prefixes) {
    if (firstLine.toUpperCase().startsWith(p + " ")) {
      return firstLine.slice(p.length).trim();
    }
    if (firstLine.toUpperCase() === p) return node.text || "";
  }
  return firstLine;
}

export function mergeEnhancedTexts(workflow, enhancedTexts) {
  const merged = { ...(enhancedTexts && typeof enhancedTexts === "object" ? enhancedTexts : {}) };
  for (const n of workflow?.nodes || []) {
    if (!merged[n.id]) merged[n.id] = n.text || "";
  }
  return merged;
}

/** v3 产物：main.flow + 逐节点 .pseudo */
export function formatPseudocodeBundle(workflow, descById) {
  const mainFlow = assembleMainFlow(workflow);
  const nodeFiles = buildAllNodePseudoFiles(workflow, descById);
  return { mainFlow, nodeFiles };
}

/** @deprecated 旧版合并文本；请用 serializePseudocodeBundle */
export function formatPseudocodeOutput(workflow, texts) {
  const { mainFlow, nodeFiles } = formatPseudocodeBundle(workflow, texts);
  return serializePseudocodeBundle({ mainFlow, nodeFiles });
}
