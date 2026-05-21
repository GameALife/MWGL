/** 六种操作方式 */
export const GEN_MODES = {
  regen_workflow: {
    label: "重新生成工作流",
    hint: "根据上方需求调用模型生成首图。开启 Top-2 时，必须依次完成「初次修改」与「最终确认」后才能进入搜索，不可跳过。",
    target: "workflow",
    incremental: false
  },
  regen_pseudo: {
    label: "重新生成伪代码",
    hint: "忽略现有伪代码，按当前画布工作流完整重生成",
    target: "pseudo",
    incremental: false
  },
  regen_code: {
    label: "重新生成代码",
    hint: "忽略现有代码，按伪代码与工作流完整重生成",
    target: "code",
    incremental: false
  },
  incr_workflow: {
    label: "增量优化工作流",
    hint: "在现有工作流 JSON 上根据需求增删改（保留节点 ID）",
    target: "workflow",
    incremental: true
  },
  incr_pseudo: {
    label: "增量优化伪代码",
    hint: "在现有伪代码基础上按需求与工作流调整",
    target: "pseudo",
    incremental: true
  },
  incr_code: {
    label: "增量优化代码",
    hint: "在现有代码基础上按伪代码与需求调整",
    target: "code",
    incremental: true
  }
};

export function getGenModeMeta(mode) {
  return GEN_MODES[mode] || GEN_MODES.regen_workflow;
}

/** 增量优化工作流 prompt（浏览器端） */
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
