/**
 * 首图人工修订阶段的结构化建议（校验 + 算子启发 + 评测条约束提示）。
 */
import { validateWorkflowConstraints } from "../js/mwgl.js";
import { suggestOpsForWorkflow } from "../routes/optimize-experience.js";
import {
  inferNeedsBranch,
  inferNeedsLoop,
  inferNeedsBranchFromMeta,
  inferNeedsLoopFromMeta,
  flattenOutputVars
} from "../scripts/eval-lang.js";

const OP_HINTS_ZH = {
  attach_failure_end: "补充具体的失败终态节点（end，outcome=failure），文案勿只写「失败」。",
  insert_step_on_edge: "在关键路径上插入 step，避免业务步骤被跳过。",
  set_branch_label: "为 branch 的每条出边填写有业务含义的 label（勿用纯数字或「分支1」）。",
  add_branch_arm: "branch 至少需要两条出边，请补足缺失的分支臂。",
  bypass_pass_through_step: "step 过多时可合并透传节点，保持 DAG 简洁。",
  set_step_text: "完善 step 文案，建议「动词 + 对象」并贴合任务描述。"
};

function tokenizeText(value) {
  const text = String(value || "").toLowerCase();
  const words = text.match(/[a-z0-9_]+/g) || [];
  const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
  return new Set([...words, ...cjk]);
}

function pickTopEvalItem(evalDataset, prompt, topk = 3) {
  if (!Array.isArray(evalDataset) || evalDataset.length === 0) return null;
  const promptTokens = tokenizeText(prompt);
  if (promptTokens.size === 0) return evalDataset[0];
  let best = evalDataset[0];
  let bestScore = -1;
  for (const item of evalDataset) {
    const text = String(item?.input?.user_text || item?.user_text || "");
    const tokens = tokenizeText(text);
    let hit = 0;
    for (const t of promptTokens) {
      if (tokens.has(t)) hit += 1;
    }
    const score = hit / Math.sqrt(promptTokens.size * Math.max(1, tokens.size));
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

function evalConstraintHints(workflow, evalItem, prompt) {
  if (!evalItem) return [];
  const hints = [];
  const exp = evalItem.expected || {};
  const userText = String(evalItem?.input?.user_text || evalItem?.user_text || prompt || "");

  const needsBranch =
    exp.needs_branch === true ||
    inferNeedsBranchFromMeta(evalItem?.meta) ||
    inferNeedsBranch(userText);
  const needsLoop =
    exp.needs_loop === true ||
    inferNeedsLoopFromMeta(evalItem?.meta) ||
    inferNeedsLoop(userText);

  const nodes = workflow?.nodes || [];
  const edges = workflow?.edges || [];
  const hasBranch = nodes.some((n) => n.type === "branch");
  const hasLoop = nodes.some((n) => n.type === "step" && n.loop?.steps?.length);

  if (needsBranch && !hasBranch) {
    hints.push("评测约束：任务可能需要条件分支（branch），请用 branch + 语义化 label 表达判断。");
  }
  if (needsLoop && !hasLoop) {
    hints.push("评测约束：任务可能需要循环，请在 step 上使用 loop（for/while + steps）。");
  }

  const labels = exp.must_have_path_labels || [];
  const edgeLabels = new Set(edges.map((e) => String(e.label || "").trim()).filter(Boolean));
  for (const lb of labels) {
    if (!edgeLabels.has(String(lb).trim())) {
      hints.push(`评测约束：边上宜出现路径标签「${lb}」。`);
    }
  }

  const outVars = flattenOutputVars(exp.output_vars || []);
  const blob = JSON.stringify(workflow).toLowerCase();
  for (const v of outVars.slice(0, 6)) {
    const key = String(v).toLowerCase();
    if (key && !blob.includes(key)) {
      hints.push(`评测约束：输出/结果变量「${v}」宜体现在节点或边文案中。`);
    }
  }

  if (exp.final_state) {
    const wantSuccess = String(exp.final_state).includes("成功");
    const hasSuccess = nodes.some((n) => n.type === "end" && n.outcome === "success");
    const hasFailure = nodes.some((n) => n.type === "end" && n.outcome === "failure");
    if (wantSuccess && !hasSuccess) {
      hints.push("评测约束：应有成功终态（end / outcome=success）。");
    }
    if (!wantSuccess && !hasFailure) {
      hints.push("评测约束：任务可能以失败终态结束，请补充 outcome=failure 的 end。");
    }
  }

  return hints;
}

/**
 * @param {object} workflow
 * @param {{ prompt?: string, evalDataset?: object[] }} options
 */
export function buildWorkflowSuggestions(workflow, options = {}) {
  const prompt = String(options.prompt || "").trim();
  const normalized = workflow;
  const check = validateWorkflowConstraints(normalized);
  const items = [];

  if (!check.ok && Array.isArray(check.errors)) {
    for (const err of check.errors) {
      items.push({ kind: "constraint", text: String(err) });
    }
  }

  const ops = suggestOpsForWorkflow(normalized, validateWorkflowConstraints);
  for (const op of ops) {
    const text = OP_HINTS_ZH[op] || `可考虑算子：${op}`;
    items.push({ kind: "operator", op, text });
  }

  const evalItem = pickTopEvalItem(options.evalDataset, prompt, 3);
  for (const text of evalConstraintHints(normalized, evalItem, prompt)) {
    items.push({ kind: "eval", text });
  }

  if (items.length === 0) {
    items.push({
      kind: "ok",
      text: "当前图已通过基础校验；可按业务需要微调文案或分支，然后继续 Top-2（将基于本图再生成 3 张变体并搜索）。"
    });
  } else {
    items.unshift({
      kind: "intro",
      text: "以下为系统参考（可选阅读）；请在面板中填写你自己的补充意见后开始 Top-2。"
    });
  }

  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    const key = it.text;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }

  return {
    ok: check.ok,
    constraint_errors: check.errors || [],
    suggested_ops: ops,
    eval_item_id: evalItem?.id ?? null,
    items: deduped
  };
}
