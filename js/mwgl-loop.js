/**
 * MWGL v3 循环体：loop.steps 树 + subworkflows 子图（均保持 DAG，不写入主图 edges）。
 */
import { uid } from "./ids.js";

export const LOOP_KINDS = new Set(["for", "while"]);
export const LOOP_STEP_TYPES = new Set(["step", "loop", "branch", "subflow"]);

function deepClone(v) {
  return JSON.parse(JSON.stringify(v || {}));
}

export function createEmptyLoop(kind = "for", condition = "") {
  return {
    kind: LOOP_KINDS.has(kind) ? kind : "for",
    condition: String(condition || "").trim(),
    steps: []
  };
}

export function createLoopStepItem(type, partial = {}) {
  const t = LOOP_STEP_TYPES.has(type) ? type : "step";
  const base = { id: String(partial.id || uid("ls")), type: t };
  if (t === "step") {
    return { ...base, text: String(partial.text || "循环内步骤") };
  }
  if (t === "loop") {
    return {
      ...base,
      text: String(partial.text || "嵌套循环"),
      loop: normalizeLoopSpec(partial.loop || createEmptyLoop())
    };
  }
  if (t === "branch") {
    return {
      ...base,
      text: String(partial.text || "条件分支"),
      arms: Array.isArray(partial.arms)
        ? partial.arms.map((a) => ({
            label: String(a?.label || "条件").trim() || "条件",
            steps: normalizeLoopSteps(a?.steps)
          }))
        : [
            { label: "是", steps: [] },
            { label: "否", steps: [] }
          ]
    };
  }
  if (t === "subflow") {
    return {
      ...base,
      ref: String(partial.ref || uid("R_sub_")),
      text: String(partial.text || "子工作流")
    };
  }
  return base;
}

export function normalizeLoopSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s) => s && typeof s === "object")
    .map((s) => {
      const type = LOOP_STEP_TYPES.has(s.type) ? s.type : "step";
      if (type === "step") {
        return { id: String(s.id || uid("ls")), type: "step", text: String(s.text || "循环内步骤") };
      }
      if (type === "loop") {
        return {
          id: String(s.id || uid("ls")),
          type: "loop",
          text: String(s.text || "嵌套循环"),
          loop: normalizeLoopSpec(s.loop)
        };
      }
      if (type === "branch") {
        const arms = Array.isArray(s.arms) ? s.arms : [];
        return {
          id: String(s.id || uid("ls")),
          type: "branch",
          text: String(s.text || "条件分支"),
          arms: arms.map((a, idx) => ({
            label: String(a?.label || "").trim() || `分支${idx + 1}`,
            steps: normalizeLoopSteps(a?.steps)
          }))
        };
      }
      if (type === "subflow") {
        return {
          id: String(s.id || uid("ls")),
          type: "subflow",
          ref: String(s.ref || uid("R_sub_")),
          text: String(s.text || "子工作流")
        };
      }
      return { id: uid("ls"), type: "step", text: "未命名" };
    });
}

export function normalizeLoopSpec(loop) {
  if (!loop || typeof loop !== "object") return createEmptyLoop();
  const kind = LOOP_KINDS.has(String(loop.kind)) ? String(loop.kind) : "for";
  return {
    kind,
    condition: String(loop.condition || "").trim(),
    steps: normalizeLoopSteps(loop.steps)
  };
}


function validateLoopSteps(steps, pathPrefix, errors, subworkflows) {
  if (!Array.isArray(steps)) {
    errors.push(`${pathPrefix}: steps 必须是数组`);
    return;
  }
  const seen = new Set();
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    const p = `${pathPrefix}[${i}]`;
    if (!s || typeof s !== "object") {
      errors.push(`${p}: 非法步骤项`);
      continue;
    }
    const id = String(s.id || "").trim();
    if (!id) errors.push(`${p}: 缺少 id`);
    else if (seen.has(id)) errors.push(`${p}: 重复 id ${id}`);
    else seen.add(id);

    const type = String(s.type || "");
    if (!LOOP_STEP_TYPES.has(type)) {
      errors.push(`${p}: type 须为 step|loop|branch|subflow`);
      continue;
    }

    if (type === "step" && !String(s.text || "").trim()) {
      errors.push(`${p}: step 文案不能为空`);
    }

    if (type === "loop") {
      if (!s.loop || typeof s.loop !== "object") {
        errors.push(`${p}: 缺少 loop 对象`);
      } else {
        validateLoopSpec(s.loop, `${p}.loop`, errors, subworkflows);
      }
    }

    if (type === "branch") {
      const arms = Array.isArray(s.arms) ? s.arms : [];
      if (arms.length < 2) errors.push(`${p}: branch 至少 2 个 arm`);
      const labels = new Set();
      for (let j = 0; j < arms.length; j += 1) {
        const arm = arms[j];
        const lab = String(arm?.label || "").trim();
        if (!lab) errors.push(`${p}.arms[${j}]: label 不能为空`);
        else if (labels.has(lab)) errors.push(`${p}.arms[${j}]: label 重复`);
        else labels.add(lab);
        validateLoopSteps(arm?.steps, `${p}.arms[${j}].steps`, errors, subworkflows);
      }
    }

    if (type === "subflow") {
      const ref = String(s.ref || "").trim();
      if (!ref) errors.push(`${p}: subflow 缺少 ref`);
      else if (!subworkflows?.[ref]) {
        errors.push(`${p}: 未找到子工作流定义 subworkflows.${ref}`);
      }
    }
  }
}

export function validateLoopSpec(loop, pathPrefix, errors, subworkflows) {
  if (!loop || typeof loop !== "object") {
    errors.push(`${pathPrefix}: loop 必须是对象`);
    return;
  }
  const kind = String(loop.kind || "");
  if (!LOOP_KINDS.has(kind)) {
    errors.push(`${pathPrefix}: loop.kind 须为 for 或 while`);
  }
  validateLoopSteps(loop.steps, `${pathPrefix}.steps`, errors, subworkflows);
}

/** 校验主工作流上的 loop 字段与 subworkflows（不改变主图 DAG） */
export function validateWorkflowLoops(workflow) {
  const errors = [];
  const subworkflows = workflow?.subworkflows && typeof workflow.subworkflows === "object"
    ? workflow.subworkflows
    : {};

  for (const n of workflow?.nodes || []) {
    if (!n?.loop) continue;
    if (n.type !== "step") {
      errors.push(`节点 ${n.id}: 仅 step 可携带 loop`);
      continue;
    }
    validateLoopSpec(n.loop, `节点 ${n.id}.loop`, errors, subworkflows);
  }

  return { ok: errors.length === 0, errors };
}

export function normalizeNodeLoop(node) {
  if (!node || typeof node !== "object") return node;
  if (!node.loop) {
    const copy = { ...node };
    delete copy.loop;
    return copy;
  }
  return {
    ...node,
    type: "step",
    loop: normalizeLoopSpec(node.loop)
  };
}

/** 按路径获取当前编辑的 loop 对象：path 为嵌套 loop 步骤的下标链 */
export function resolveLoopContext(rootLoop, pathIndices) {
  let loop = rootLoop;
  if (!loop) return null;
  const chain = Array.isArray(pathIndices) ? pathIndices : [];
  for (let depth = 0; depth < chain.length; depth += 1) {
    const idx = chain[depth];
    const step = loop.steps?.[idx];
    if (!step || step.type !== "loop" || !step.loop) return null;
    loop = step.loop;
  }
  return loop;
}

/** 将 loop.steps 展平为伪代码行（缩进 depth） */
export function loopStepsToPseudoLines(steps, depth, subworkflows, lines) {
  const pad = "  ".repeat(depth);
  for (const s of steps || []) {
    if (s.type === "step") {
      lines.push(`${pad}STEP ${s.text || ""}`);
    } else if (s.type === "branch") {
      const arms = s.arms || [];
      arms.forEach((arm, i) => {
        const kw = i === 0 ? "IF" : "ELSE IF";
        lines.push(`${pad}${kw} ${arm.label}`);
        loopStepsToPseudoLines(arm.steps, depth + 1, subworkflows, lines);
      });
    } else if (s.type === "loop") {
      const lk = s.loop?.kind === "while" ? "WHILE" : "FOR";
      const cond = s.loop?.condition || "/* 条件 */";
      lines.push(`${pad}${lk} ${cond}`);
      loopStepsToPseudoLines(s.loop?.steps, depth + 1, subworkflows, lines);
      lines.push(`${pad}END ${lk}`);
    } else if (s.type === "subflow") {
      const ref = s.ref;
      const sub = subworkflows?.[ref];
      lines.push(`${pad}SUBFLOW ${ref} "${s.text || sub?.rule_name || ""}"`);
      if (sub?.nodes?.length) {
        lines.push(`${pad}  BEGIN SUBWORKFLOW ${ref}`);
        lines.push(`${pad}  /* 子图 ${sub.nodes.length} 节点，由主流程渲染 */`);
        lines.push(`${pad}  END SUBWORKFLOW ${ref}`);
      }
    }
  }
}

export function appendLoopPseudoForNode(node, subworkflows, lines, depth = 1) {
  if (!node?.loop) return;
  const lk = node.loop.kind === "while" ? "WHILE" : "FOR";
  const cond = node.loop.condition || "/* 条件 */";
  const pad = "  ".repeat(depth);
  lines.push(`${pad}${lk} ${cond}`);
  loopStepsToPseudoLines(node.loop.steps, depth + 1, subworkflows, lines);
  lines.push(`${pad}END ${lk}`);
}

export function createEmptySubworkflow(ruleName) {
  const startId = uid("n");
  const endId = uid("n");
  return {
    rule_name: ruleName || "子工作流",
    nodes: [
      { id: startId, type: "start", text: "子流程开始", x: 80, y: 120 },
      { id: endId, type: "end", outcome: "success", text: "子流程结束", x: 360, y: 120 }
    ],
    edges: [{ id: uid("e"), from: startId, to: endId, label: "" }]
  };
}

export function cloneLoopSpec(loop) {
  return deepClone(normalizeLoopSpec(loop));
}
