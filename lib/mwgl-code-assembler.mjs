import {
  buildGraph,
  topoSort,
  reachableFromStart,
  findConvergence,
  safeFn
} from "./mwgl-graph-utils.mjs";
import { getCodeLang } from "./mwgl-code-lang.mjs";

/** parallel 节点无独立函数，由 main 对各臂 node_* 做并行调用。 */
export const CODE_GEN_NODE_TYPES = new Set(["start", "step", "branch", "end"]);

export function needsNodeFunction(node) {
  return node && CODE_GEN_NODE_TYPES.has(node.type);
}

/** LLM 未返回时生成占位函数，保证 main 可编译。 */
export function buildNodeStub(node, language) {
  const lang = getCodeLang(language);
  const fn = safeFn(node.id);
  const sp = " ".repeat(lang.indent);
  const lines = [lang.def(fn)];
  if (lang.stub) lines.push(lang.stub(fn, sp));
  else lines.push(`${sp}${lang.comment} TODO`, `${sp}return ctx`);
  if (lang.endDef) lines.push(lang.endDef);
  return lines.join("\n");
}

/**
 * 按工作流图结构确定性生成 main（分支/并行/循环体在 node_* 内，不在 main 展开循环）。
 */
export function assembleMainFromFlow(workflow, language) {
  const lang = getCodeLang(language);
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

      case "parallel": {
        const conv = findConvergence(
          outs.map((e) => e.to),
          outEdges,
          nodeMap,
          topoIndex
        );
        if (lang.parallel && outs.length > 0) {
          lines.push(lang.parallel(outs.map((e) => safeFn(e.to)), s));
        } else {
          for (const e of outs) {
            lines.push(lang.call(safeFn(e.to), s));
          }
        }
        if (conv) traverse(conv, level, stopBefore);
        break;
      }

      case "end":
        if (node.outcome === "failure") lines.push(lang.failure(fn, s));
        else lines.push(lang.success(fn, s));
        break;

      default:
        if (needsNodeFunction(node)) lines.push(lang.call(fn, s));
        for (const e of outs) traverse(e.to, level, stopBefore);
    }
  }

  const mainLines = [lang.mainStart, lang.mainCtx(sp(1))];
  if (start) traverse(start.id, 1, null);
  mainLines.push(...lines);
  if (lang.mainEnd) mainLines.push(lang.mainEnd);
  return mainLines.join("\n");
}

/** 拼装完整可执行代码：imports + 逐节点函数 + main。 */
export function assembleFullCode({ workflow, fnMap, language }) {
  const lang = getCodeLang(language);
  const mainFunction = assembleMainFromFlow(workflow, language);
  const parts = [];

  if (lang.classWrap) parts.push(`public class ${lang.className} {`);
  if (lang.imports) parts.push(lang.imports);

  parts.push(`${lang.comment} ========== 逐节点函数 ==========`);
  parts.push("");

  for (const node of workflow.nodes || []) {
    if (!needsNodeFunction(node)) continue;
    let code = fnMap[node.id];
    if (!code) code = buildNodeStub(node, language);
    parts.push(lang.classWrap ? code.split("\n").map((l) => "  " + l).join("\n") : code);
    parts.push("");
  }

  parts.push(`${lang.comment} ========== 主函数（按图结构自动拼装） ==========`);
  parts.push("");
  parts.push(mainFunction);
  if (lang.footer) parts.push(lang.classWrap ? "  " + lang.footer.trim() : lang.footer);
  if (lang.classWrap) parts.push("}");

  return parts.join("\n");
}
