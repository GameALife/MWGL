import {
  buildGraph,
  topoSort,
  reachableFromStart,
  findConvergence
} from "./mwgl-graph-utils.mjs";
import { appendLoopPseudoForNode } from "../js/mwgl-loop.js";

/**
 * 按图结构确定性拼装伪代码（控制流由程序决定，LLM 只润色各节点单行描述）。
 */
export function assemblePseudocode(workflow, texts) {
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

/** 为伪代码→代码步骤生成逐节点 .pseudo 块（含循环体展开）。 */
export function buildPerNodePseudoBlocks(workflow, texts) {
  const { nodes } = buildGraph(workflow);
  const subworkflows = workflow?.subworkflows || {};
  const blocks = [];

  for (const node of nodes) {
    const desc = texts[node.id] || node.text || "";
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

    if (lines.length) {
      blocks.push(`--- ${node.id}.pseudo ---\n${lines.join("\n")}`);
    }
  }

  return blocks.join("\n\n");
}

/** 主伪代码 + 逐节点附录，供 skill3 解析完整片段。 */
export function formatPseudocodeOutput(workflow, texts) {
  const main = assemblePseudocode(workflow, texts);
  const appendix = buildPerNodePseudoBlocks(workflow, texts);
  if (!appendix) return main;
  return `${main}\n\n# ========== 逐节点伪代码（供代码生成解析） ==========\n\n${appendix}`;
}

/** 合并 LLM 润色结果，缺失 id 回退为节点原始 text。 */
export function mergeEnhancedTexts(workflow, enhancedTexts) {
  const merged = { ...(enhancedTexts && typeof enhancedTexts === "object" ? enhancedTexts : {}) };
  for (const n of workflow?.nodes || []) {
    if (!merged[n.id]) merged[n.id] = n.text || "";
  }
  return merged;
}
