/** 将 loop.steps 树压缩为提示词/用户消息用的文本摘要 */
export function summarizeLoopSteps(steps, depth = 0) {
  const pad = "  ".repeat(depth);
  const lines = [];
  for (const s of steps || []) {
    if (s.type === "step") {
      lines.push(`${pad}- step: ${s.text || ""}`);
    } else if (s.type === "branch") {
      lines.push(`${pad}- branch: ${s.text || ""}`);
      for (const arm of s.arms || []) {
        lines.push(`${pad}  arm "${arm.label || "条件"}":`);
        const inner = summarizeLoopSteps(arm.steps, depth + 2);
        if (inner) lines.push(inner);
      }
    } else if (s.type === "loop") {
      const kind = s.loop?.kind === "while" ? "while" : "for";
      lines.push(
        `${pad}- nested ${kind} "${s.loop?.condition || ""}": ${s.text || ""}`
      );
      const inner = summarizeLoopSteps(s.loop?.steps, depth + 1);
      if (inner) lines.push(inner);
    } else if (s.type === "subflow") {
      lines.push(`${pad}- subflow ref=${s.ref || ""}: ${s.text || ""}`);
    }
  }
  return lines.join("\n");
}

/** 单个 step 节点上的 loop 对象摘要 */
export function summarizeNodeLoop(node) {
  if (!node?.loop) return "";
  const kind = node.loop.kind === "while" ? "while" : "for";
  const cond = String(node.loop.condition || "").trim() || "(未写条件)";
  const body = summarizeLoopSteps(node.loop.steps, 1);
  return [`loop.kind=${kind}`, `loop.condition=${cond}`, body ? `loop.steps:\n${body}` : "loop.steps=(空)"].join(
    "\n"
  );
}
