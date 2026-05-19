/**
 * MWGL v3 安全图变异：小步、可校验、不引入 loop/parallel 等易碎结构。
 */

function deepClone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function randomItem(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

export function nextNodeId(workflow, hint = "step") {
  const ids = new Set((workflow.nodes || []).map((n) => String(n.id)));
  let i = 1;
  while (ids.has(`n_${hint}_${i}`)) i += 1;
  return `n_${hint}_${i}`;
}

export function nextEdgeId(workflow) {
  const ids = new Set((workflow.edges || []).map((e) => String(e.id)));
  let i = 1;
  while (ids.has(`e_${i}`)) i += 1;
  return `e_${i}`;
}

function buildGraph(workflow) {
  const nodes = workflow.nodes || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of workflow.edges || []) {
    if (out.has(e.from) && byId.has(e.to)) out.get(e.from).push(e);
  }
  return { byId, out };
}

/** @returns {{ workflow: object, op: string } | null} */
function opSetStepText(workflow) {
  const steps = (workflow.nodes || []).filter((n) => n.type === "step");
  const node = randomItem(steps);
  if (!node) return null;
  const mutated = deepClone(workflow);
  const target = mutated.nodes.find((n) => n.id === node.id);
  if (!target) return null;
  const t = String(target.text || "").trim();
  if (!t || /^未命名/.test(t)) {
    target.text = "执行业务步骤";
  } else if (!t.endsWith("（细化）")) {
    target.text = `${t}（细化）`;
  } else {
    target.text = t.replace(/（细化）$/, "");
  }
  return { workflow: mutated, op: "set_step_text" };
}

/** @returns {{ workflow: object, op: string } | null} */
function opSetBranchLabel(workflow) {
  const { byId } = buildGraph(workflow);
  const branchEdges = (workflow.edges || []).filter((e) => byId.get(e.from)?.type === "branch");
  const edge = randomItem(branchEdges);
  if (!edge) return null;
  const pool = ["已满足", "未满足", "超时", "权限不足", "需重试", "校验失败"];
  const mutated = deepClone(workflow);
  const target = mutated.edges.find((e) => e.id === edge.id);
  if (!target) return null;
  target.label = randomItem(pool) || "其他条件";
  return { workflow: mutated, op: "set_branch_label" };
}

/** @returns {{ workflow: object, op: string } | null} */
function opInsertStepOnEdge(workflow) {
  const { byId } = buildGraph(workflow);
  const candidates = (workflow.edges || []).filter((e) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    return from && to && from.type !== "end" && to.type !== "branch";
  });
  const edge = randomItem(candidates);
  if (!edge) return null;
  const mutated = deepClone(workflow);
  const midId = nextNodeId(mutated, "step");
  mutated.nodes.push({
    id: midId,
    type: "step",
    text: "补充处理步骤",
    x: 400,
    y: 200
  });
  const old = mutated.edges.find((e) => e.id === edge.id);
  if (!old) return null;
  const oldTo = old.to;
  old.to = midId;
  mutated.edges.push({
    id: nextEdgeId(mutated),
    from: midId,
    to: oldTo,
    label: ""
  });
  return { workflow: mutated, op: "insert_step_on_edge" };
}

/** @returns {{ workflow: object, op: string } | null} */
function opAddBranchArm(workflow) {
  const branches = (workflow.nodes || []).filter((n) => n.type === "branch");
  const branch = randomItem(branches);
  if (!branch) return null;
  const mutated = deepClone(workflow);
  const outs = mutated.edges.filter((e) => e.from === branch.id);
  const used = new Set(outs.map((e) => String(e.label || "").trim()).filter(Boolean));
  let label = "是";
  if (used.has("是")) label = "否";
  for (let i = 3; i <= 20; i += 1) {
    const c = `条件${i}`;
    if (!used.has(c)) {
      label = c;
      break;
    }
  }
  const stepId = nextNodeId(mutated, "step");
  mutated.nodes.push({
    id: stepId,
    type: "step",
    text: "新分支步骤",
    x: Number(branch.x || 0) + 280,
    y: Number(branch.y || 0) + outs.length * 80
  });
  mutated.edges.push({
    id: nextEdgeId(mutated),
    from: branch.id,
    to: stepId,
    label
  });
  return { workflow: mutated, op: "add_branch_arm" };
}

/** @returns {{ workflow: object, op: string } | null} */
function opAttachFailureEnd(workflow) {
  const { byId, out } = buildGraph(workflow);
  const hasFailureEnd = (workflow.nodes || []).some((n) => n.type === "end" && n.outcome === "failure");
  const sources = (workflow.nodes || []).filter((n) => {
    if (n.type === "end" || n.type === "start") return false;
    const outs = out.get(n.id) || [];
    const alreadyToFailure = outs.some((e) => byId.get(e.to)?.type === "end" && byId.get(e.to)?.outcome === "failure");
    return !alreadyToFailure && outs.length <= 1;
  });
  const from = randomItem(sources);
  if (!from) return null;

  const mutated = deepClone(workflow);
  let failureEnd = mutated.nodes.find((n) => n.type === "end" && n.outcome === "failure");
  if (!failureEnd) {
    failureEnd = {
      id: nextNodeId(mutated, "end_fail"),
      type: "end",
      outcome: "failure",
      text: "任务未达成-条件不满足",
      x: 720,
      y: 280
    };
    mutated.nodes.push(failureEnd);
  }
  if ((mutated.edges || []).some((e) => e.from === from.id && e.to === failureEnd.id)) {
    return null;
  }
  mutated.edges.push({
    id: nextEdgeId(mutated),
    from: from.id,
    to: failureEnd.id,
    label: from.type === "branch" ? "未通过" : ""
  });
  return { workflow: mutated, op: "attach_failure_end" };
}

/** @returns {{ workflow: object, op: string } | null} */
function opBypassPassThroughStep(workflow) {
  const { out, byId } = buildGraph(workflow);
  const candidates = (workflow.nodes || []).filter((n) => {
    if (n.type !== "step") return false;
    const outs = out.get(n.id) || [];
    const ins = (workflow.edges || []).filter((e) => e.to === n.id);
    return ins.length === 1 && outs.length === 1;
  });
  const target = randomItem(candidates);
  if (!target) return null;
  const mutated = deepClone(workflow);
  const inEdge = mutated.edges.find((e) => e.to === target.id);
  const outEdge = mutated.edges.find((e) => e.from === target.id);
  if (!inEdge || !outEdge) return null;
  if (byId.get(outEdge.to)?.type === "branch") return null;
  inEdge.to = outEdge.to;
  inEdge.label = inEdge.label || outEdge.label;
  mutated.edges = mutated.edges.filter((e) => e.id !== outEdge.id);
  mutated.nodes = mutated.nodes.filter((n) => n.id !== target.id);
  return { workflow: mutated, op: "bypass_pass_through_step" };
}

export const MUTATION_OPERATORS = [
  opSetStepText,
  opSetBranchLabel,
  opInsertStepOnEdge,
  opAddBranchArm,
  opAttachFailureEnd,
  opBypassPassThroughStep
];

export const MUTATION_OP_IDS = [
  "set_step_text",
  "set_branch_label",
  "insert_step_on_edge",
  "add_branch_arm",
  "attach_failure_end",
  "bypass_pass_through_step"
];

export const MUTATION_SEMANTICS_ZH = {
  set_step_text: "细化某个 step 的文案，不改变拓扑",
  set_branch_label: "修改 branch 某条出边的条件 label",
  insert_step_on_edge: "在一条顺序边上插入新 step",
  add_branch_arm: "为 branch 增加一条带 label 的新出边及 step",
  attach_failure_end: "从某节点连到 failure 终态（若无则创建）",
  bypass_pass_through_step: "删除仅串联用的单入单出 step"
};
