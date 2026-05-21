import { summarizeNodeLoop } from "./mwgl-loop-summary.mjs";

export const NODE_PSEUDO_SYSTEM = `你是 MWGL v3 单节点伪代码撰写器。

## 任务
根据输入为**一个**工作流节点撰写 .pseudo 文件正文（描述该节点「做什么」）。

## 输出
纯文本若干行，不要 markdown、不要代码块、不要 \`--- id.pseudo ---\` 文件头。

## 规则
- start：一行 \`BEGIN …\`，描述入口事件
- step（无 loop）：一行 \`STEP …\`，动宾结构
- step（有 loop）：仅一行 \`STEP …\` 点明循环业务目的；不要写 FOR/WHILE/END 或展开 loop.steps（程序会追加）
- branch：一行 \`IF …\`，描述判断内容
- parallel：一行 \`PARALLEL …\`，描述并行业务目的
- end：一行 \`SUCCESS …\` 或 \`FAILURE …\`（failure 须具体原因，禁单独写「失败」）

## 禁止
- 不要写主图调用顺序、不要 CALL、不要 BEGIN/END WORKFLOW
- 不要为循环内子步骤单独输出（循环体由程序按 loop.steps 拼装）`;

export function buildSingleNodePseudoUserMessage(workflow, node, { existingPseudo = "", revisionNotes = "" } = {}) {
  const outEdges = (workflow?.edges || []).filter((e) => e.from === node.id);
  const parts = [
    "## 节点",
    `id: ${node.id}`,
    `type: ${node.type}`,
    node.outcome ? `outcome: ${node.outcome}` : "",
    `原始描述: ${node.text || ""}`,
    "",
    "## 出边",
    outEdges.length
      ? outEdges.map((e) => `- → ${e.to} (${e.label || "无标签"}) [edge ${e.id}]`).join("\n")
      : "(无)",
    ""
  ].filter(Boolean);

  const loopSum = summarizeNodeLoop(node);
  if (loopSum) parts.push("## loop 摘要", loopSum, "");

  if (existingPseudo?.trim()) {
    parts.push("## 现有 .pseudo 正文", existingPseudo.trim(), "");
  }
  if (revisionNotes?.trim()) {
    parts.push("## 用户修改意见", revisionNotes.trim(), "");
  }

  parts.push("请输出该节点的 .pseudo 正文。");
  return parts.join("\n");
}

export const NODE_CODE_SYSTEM = `你是 MWGL v3 单节点代码生成器。

## 任务
为**一个**工作流节点生成独立可执行函数（函数名 node_{id}，参数 ctx，返回 ctx）。

## 输出
仅输出该节点的完整函数代码，不要 markdown、不要 JSON、不要其它节点。

## 规则
- start：初始化 ctx
- step（无 loop）：业务逻辑 + return ctx
- step（有 loop）：函数内完整 for/while（按 loop.kind/condition），循环体按伪代码 FOR/WHILE 块与 loop.steps 实现
- branch：设置 ctx["branch"] 与出边 label 完全一致，return ctx
- end：success → ctx["status"]="success"；failure → ctx["status"]="failure"
- parallel：不生成函数（由 main 并行调用各臂）

模拟数据 + TODO 中文注释；按目标语言写完整函数。`;

export function buildSingleNodeCodeUserMessage(node, pseudo, language) {
  const parts = [
    `## 目标语言：${language}`,
    `[${node.id}] type=${node.type}`,
    node.outcome ? `outcome=${node.outcome}` : "",
    "",
    "## 伪代码",
    pseudo || node.text || "(无)",
    ""
  ].filter(Boolean);
  const loopSum = summarizeNodeLoop(node);
  if (loopSum) parts.push(loopSum, "");
  parts.push("请输出该节点的完整函数代码。");
  return parts.join("\n");
}
