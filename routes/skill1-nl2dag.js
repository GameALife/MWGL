import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";
import { normalizeWorkflow, validateWorkflowConstraints } from "../js/mwgl.js";

const router = Router();
const MAX_REPAIR_ROUNDS = Number(process.env.MWGL_GENERATE_MAX_RETRY || 3);

const SYSTEM_PROMPT =
  "你是 MWGL v2 严格编译器。把用户需求转换成可通过 MWGL v2 校验的 JSON。只输出 JSON 对象本身，不要 markdown、不要代码块、不要解释。\n" +
  "输出结构必须是：{mwgl_version:2,rule_id:string,rule_name:string,nodes:[...],edges:[...]}；edges 必须显式输出，不允许省略。\n" +
  "nodes 每项必须包含：id,type,text,x,y。若 type=failure，可选提供 failure_kind（建议）。edges 每项必须包含：id,from,to,label（switch 出边 label 不可为空；其他可为空字符串）。\n" +
  "语义规范（非常重要）：边表达顺序连接，且在分支/触发场景中由边 label 承载条件语义。\n" +
  "术语约定：success/failure 表示业务结果终态（Outcome）；系统报错/超时/崩溃属于执行错误（Execution Error），不是 failure 的同义词。\n" +
  "failure 是“非成功终态”类型容器：可表示游戏失败结局、任务未达成、前置条件不满足等；请在 failure 节点 text 中写明具体失败语义，禁止只写“失败”。\n" +
  "节点 type 只能是：start,wait_user,switch,loop_start,loop_end,parallel,case,success,failure。\n" +
  "硬性约束（必须全部满足）：\n" +
  "1) 必须且仅有 1 个 start。\n" +
  "2) start 不能有入边，且 start 至少 1 条出边。\n" +
  "3) success/failure 不能有任何出边。\n" +
  "4) 禁止自环（from===to），全图必须 DAG（不能有有向环）。\n" +
  "5) 边的 from/to 必须引用存在的节点 id。\n" +
  "6) switch 每个节点至少 1 条出边；loop_start 必须且仅能有 1 条出边（进入循环体）；parallel 至少 2 条出边；loop_end 至少 1 条出边。\n" +
  "7) case 与 wait_user 每个节点最多 1 条出边（避免动作节点隐式分叉）。\n" +
  "8) switch 的每条出边 label 必须非空、同一 switch 下不可重复，且必须是可判定条件（业务语义）；禁止使用纯数字或\u201C分支N\u201D等占位标签。\n" +
  "9) loop_start/loop_end 必须完整成对：每个 loop_start 必须存在至少一个可达的 loop_end，且每个 loop_end 必须由至少一个 loop_start 可达。\n" +
  "10) 允许存在从 start 不可达的节点（作为设计中的草稿节点，不参与执行）。\n" +
  "11) 至少存在 1 个从 start 可达的终态（success 或 failure）。\n" +
  "12) 每个从 start 可达的非终态节点，都必须能到达某个终态（success/failure），禁止执行死路。\n" +
  "13) failure 节点 text 不得使用“失败/failure/fail”等泛化文案，必须写明具体失败语义（如“失败结局-生命值归零”“任务未达成-超时”）。\n" +
  "建模偏好：\n" +
  "- 类型选择语义优先：条件分流用 switch；迭代语义用 loop_start/loop_end；并行语义用 parallel。\n" +
  "- 在满足语义与可读性的前提下，优先生成节点更少、边更少的最小可读图，避免不必要中间节点。\n" +
  "- 节点 text 使用统一风格的业务语义文案（建议“动词+对象”），避免\u201C新动作/未命名节点\u201D等占位文本。\n" +
  "- 关键失败场景优先显式建模为 failure 路径，不只保留 happy path。\n" +
  "- parallel 各分支粒度尽量对称，并尽量在同一后继阶段汇聚。\n" +
  "- 关键转移边的 label 优先体现触发关键词（如权限不足/超时/重试上限等），增强可追踪性；前序边也可承载触发条件。\n" +
  "- 无明确要求时，尽量减少从 start 不可达的草稿节点。\n" +
  "- id 命名尽量稳定且可读（例如 n_start、n_switch_auth、e_auth_yes），便于 diff 与排查。\n" +
  "输出前请在内部自检并修正；若未满足任一硬性约束，继续修正直到全部通过后再输出最终 JSON。";

function stripMarkdownFence(text) {
  return String(text || "")
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

function validateCandidateContent(content) {
  try {
    const parsed = JSON.parse(stripMarkdownFence(content));
    const normalized = normalizeWorkflow(parsed);
    const result = validateWorkflowConstraints(normalized);
    return {
      ok: result.ok,
      errors: result.errors || [],
      normalized
    };
  } catch (error) {
    return {
      ok: false,
      errors: [`返回内容不是合法 JSON：${error.message}`],
      normalized: null
    };
  }
}

function buildRepairPrompt({ originalPrompt, previousJson, errors, round, maxRounds }) {
  const errLines = (errors || []).map((e, i) => `${i + 1}) ${e}`).join("\n");
  return [
    `你上一次生成结果未通过校验。请在原需求基础上修复，并保持业务意图不变。`,
    `当前是第 ${round}/${maxRounds} 次修复。`,
    "",
    "原始用户需求：",
    originalPrompt,
    "",
    "上一版 JSON：",
    previousJson,
    "",
    "校验错误：",
    errLines,
    "",
    "请输出修复后的完整 JSON（仅 JSON 对象本身）。"
  ].join("\n");
}

router.post("/api/mwgl/generate", async (req, res) => {
  try {
    if (!hasKey()) {
      return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY in server env." });
    }

    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) {
      return res.status(400).json({ error: "prompt is required" });
    }

    let content = await callDeepSeek([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt }
    ]);
    let checked = validateCandidateContent(content);

    for (let round = 1; round <= MAX_REPAIR_ROUNDS && !checked.ok; round += 1) {
      const repairPrompt = buildRepairPrompt({
        originalPrompt: prompt,
        previousJson: stripMarkdownFence(content),
        errors: checked.errors,
        round,
        maxRounds: MAX_REPAIR_ROUNDS
      });
      content = await callDeepSeek([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: repairPrompt }
      ]);
      checked = validateCandidateContent(content);
    }

    if (!checked.ok) {
      return res.status(422).json({
        error: "生成结果多次修复后仍未通过校验：你的要求可能过于单薄或过于复杂，请补充具体信息或精简要求。",
        details: checked.errors
      });
    }

    res.json({ content: JSON.stringify(checked.normalized) });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: error.message || "server error" });
  }
});

export default router;
