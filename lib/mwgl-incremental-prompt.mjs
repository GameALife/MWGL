/** 增量优化工作流：在原 JSON 与用户新需求基础上改写 */
export function buildIncrementalWorkflowPrompt(prompt, workflow, previousPrompt = "") {
  const chunks = [];
  if (previousPrompt) {
    chunks.push(`上一轮用户输入：\n${previousPrompt}`);
  }
  if (workflow?.nodes?.length) {
    chunks.push(
      `当前工作流 JSON（请在此基础上增量修改，不要完全重写）：\n${JSON.stringify(workflow, null, 2)}`
    );
  }
  chunks.push(`本轮修改需求：\n${prompt}`);
  return [
    "你现在处于 MWGL 工作流增量优化模式。",
    ...chunks,
    "请尽量复用原有节点/边与 ID，仅在必要处增删改。输出完整可校验的 MWGL v3 JSON。"
  ].join("\n\n");
}

const PSEUDO_INCR_SYSTEM = `你是 MWGL v3 伪代码增量优化器。

## 任务
根据现有伪代码、工作流 JSON 与用户修改意见，输出更新后的节点润色 JSON（key=节点id，value=单行描述）。

## 规则
- 不要输出完整伪代码或 FOR/WHILE 结构（程序会拼装）
- 有 loop 的 step 须在描述中体现循环语义
- 只输出 JSON 对象，不要 markdown`;

export function buildIncrementalPseudoUserMessage({
  workflow,
  existingPseudocode,
  revisionNotes,
  nodeListUserMsg
}) {
  return [
    "## 用户修改意见",
    revisionNotes || "（请根据工作流与现有伪代码做一致性微调）",
    "",
    "## 现有伪代码",
    existingPseudocode || "(空)",
    "",
    nodeListUserMsg
  ].join("\n");
}

export { PSEUDO_INCR_SYSTEM };

const CODE_INCR_SYSTEM = `你是 MWGL 工作流代码增量优化器。

## 任务
在现有可执行代码基础上，根据伪代码、工作流与用户意见做增量改进。

## 要求
- 只输出完整可执行代码，不要 markdown
- 保留 node_* + main 结构，尽量保持节点 id 对应
- 保留中文 TODO；仅按用户意见与伪代码差异调整`;

export function buildIncrementalCodeUserMessage({
  language,
  existingCode,
  pseudocode,
  workflow,
  revisionNotes
}) {
  const parts = [
    `目标语言：${language}`,
    "",
    "## 用户修改意见",
    revisionNotes || "（请与伪代码、工作流保持一致并改进可执行性）"
  ];
  if (pseudocode?.trim()) {
    parts.push("", "## 伪代码", pseudocode.trim());
  }
  if (workflow?.nodes?.length) {
    parts.push("", "## 工作流 JSON", JSON.stringify(workflow, null, 2));
  }
  parts.push("", "## 现有代码", existingCode || "(空)", "", "请输出改进后的完整代码。");
  return parts.join("\n");
}

export { CODE_INCR_SYSTEM };
