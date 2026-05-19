/** 评测集 / 打分用的终态与语言工具（Node ESM） */

export const FINAL_STATE_ALIASES = {
  success: "success",
  failure: "failure",
  成功: "success",
  失败: "failure"
};

export function normalizeFinalState(value) {
  const raw = String(value || "").trim();
  if (FINAL_STATE_ALIASES[raw]) return FINAL_STATE_ALIASES[raw];
  const lower = raw.toLowerCase();
  if (FINAL_STATE_ALIASES[lower]) return FINAL_STATE_ALIASES[lower];
  return lower;
}

export function finalStateDisplay(normalized, locale = "zh") {
  if (locale === "en") return normalized === "failure" ? "failure" : "success";
  return normalized === "failure" ? "失败" : "成功";
}

export function hasCjk(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ""));
}

export function flattenOutputVars(outputVar) {
  if (!Array.isArray(outputVar)) return [];
  const out = [];
  for (const v of outputVar) {
    if (Array.isArray(v)) out.push(...flattenOutputVars(v));
    else out.push(String(v).trim());
  }
  return [...new Set(out.filter(Boolean))];
}

/** 从任务描述推断中文路径标签 */
export function inferMustHavePathLabelsZh(text) {
  const t = String(text || "");
  const labels = [];
  if (/invalid|无效|不合法/.test(t) && /输出.*['"]?invalid|输出.*无效/i.test(t)) {
    labels.push("无效");
  }
  return labels;
}

export function inferNeedsBranchFromMeta(meta) {
  const nodes = Array.isArray(meta?.related_nodes) ? meta.related_nodes : [];
  if (nodes.some((n) => n === "question-classifier" || n === "if-else")) return true;
  if (
    nodes.includes("variable-aggregator") &&
    nodes.some((n) => ["question-classifier", "if-else", "http-request"].includes(n))
  ) {
    return true;
  }
  return false;
}

export function inferNeedsLoopFromMeta(meta) {
  const nodes = Array.isArray(meta?.related_nodes) ? meta.related_nodes : [];
  return nodes.includes("iteration");
}

export function inferNeedsBranch(text) {
  const t = String(text || "");
  return (
    /分支|添加.*分支|额外分支|三个分支|各分支|路由到|问题分类|分类器|聚合.*统一|统一.*聚合|if-else/i.test(
      t
    ) ||
    /branch|classifier|otherwise|aggregate.*unified/i.test(t.toLowerCase())
  );
}

export function inferNeedsLoop(text) {
  const t = String(text || "");
  return /迭代|批量|逐一|逐个|循环处理|one by one|iteration|iteratively/i.test(t);
}

/**
 * 由条目生成完整 expected（中文），供 jsonl 与打分共用。
 */
export function buildExpectedFromItem(item) {
  const text = String(item?.input?.user_text || "");
  const meta = item?.meta && typeof item.meta === "object" ? item.meta : {};
  const prev = item?.expected && typeof item.expected === "object" ? item.expected : {};

  const normalized = normalizeFinalState(prev.final_state || "成功");
  const needsBranch =
    typeof prev.needs_branch === "boolean"
      ? prev.needs_branch
      : inferNeedsBranchFromMeta(meta) || inferNeedsBranch(text);
  const needsLoop =
    typeof prev.needs_loop === "boolean"
      ? prev.needs_loop
      : inferNeedsLoopFromMeta(meta) || inferNeedsLoop(text);

  let labels = Array.isArray(prev.must_have_path_labels)
    ? prev.must_have_path_labels.map((x) => String(x).trim()).filter(Boolean)
    : [];
  for (const l of inferMustHavePathLabelsZh(text)) {
    if (!labels.includes(l)) labels.push(l);
  }

  const inputVars = Array.isArray(prev.input_vars)
    ? prev.input_vars.map((x) => String(x).trim()).filter(Boolean)
    : Array.isArray(meta.input_var)
      ? meta.input_var.map((x) => String(x).trim()).filter(Boolean)
      : [];

  const outputVars = Array.isArray(prev.output_vars)
    ? prev.output_vars.map((x) => String(x).trim()).filter(Boolean)
    : flattenOutputVars(meta.output_var);

  return {
    final_state: finalStateDisplay(normalized, "zh"),
    must_have_path_labels: labels,
    needs_branch: needsBranch,
    needs_loop: needsLoop,
    input_vars: inputVars,
    output_vars: outputVars
  };
}
