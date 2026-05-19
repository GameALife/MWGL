/**
 * 搜索记忆：UCB 算子选择、失败 tabu、校验启发式、父节点 softmax 排序。
 */

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function randomItem(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

/** 按校验错误与图结构缺口，推荐优先尝试的算子 id（MWGL v3） */
export function suggestOpsForWorkflow(workflow, validateFn) {
  const suggested = [];
  const nodes = workflow?.nodes || [];
  const edges = workflow?.edges || [];
  const hasFailureEnd = nodes.some((n) => n.type === "end" && n.outcome === "failure");
  const hasSuccessEnd = nodes.some((n) => n.type === "end" && n.outcome === "success");
  const branches = nodes.filter((n) => n.type === "branch");

  if (!hasFailureEnd) suggested.push("attach_failure_end");
  if (!hasSuccessEnd) suggested.push("insert_step_on_edge", "attach_failure_end");
  if (branches.length === 0 && nodes.some((n) => n.type === "step")) {
    suggested.push("insert_step_on_edge");
  }
  for (const br of branches) {
    const outs = edges.filter((e) => e.from === br.id);
    if (outs.length < 2) suggested.push("add_branch_arm");
    if (outs.some((e) => !String(e.label || "").trim())) suggested.push("set_branch_label");
  }
  if (nodes.filter((n) => n.type === "step").length > 8) {
    suggested.push("bypass_pass_through_step");
  }

  if (typeof validateFn === "function") {
    const check = validateFn(workflow);
    if (!check?.ok && Array.isArray(check.errors)) {
      for (const err of check.errors) {
        const t = String(err).toLowerCase();
        if (t.includes("end") && t.includes("failure")) {
          suggested.push("attach_failure_end", "set_step_text");
        }
        if (t.includes("branch") || t.includes("label")) {
          suggested.push("set_branch_label", "add_branch_arm");
        }
        if (t.includes("step") && t.includes("出边")) {
          suggested.push("insert_step_on_edge", "bypass_pass_through_step");
        }
      }
    }
  }

  return [...new Set(suggested)];
}

function prioritizeChoices(validChoices, preferredOps) {
  if (!preferredOps?.length) return validChoices;
  const pref = new Set(preferredOps);
  const front = validChoices.filter((c) => pref.has(c.op));
  const rest = validChoices.filter((c) => !pref.has(c.op));
  return [...front, ...rest];
}

export class SearchExperience {
  constructor({ tabuFailures = 3, epsilon = 0.2 } = {}) {
    this.tabuFailures = Math.max(1, tabuFailures);
    this.epsilon = clamp(epsilon, 0, 1);
    this.stats = new Map();
    this.globalTries = 0;
  }

  _key(parentSig, op) {
    return `${parentSig}::${op}`;
  }

  isTabu(parentSig, op) {
    const s = this.stats.get(this._key(parentSig, op));
    return Boolean(s?.tabu);
  }

  selectOperator(parentSig, validChoices, preferredOps = []) {
    if (!validChoices.length) return null;

    let pool = validChoices.filter((c) => !this.isTabu(parentSig, c.op));
    if (pool.length === 0) pool = validChoices;
    pool = prioritizeChoices(pool, preferredOps);

    if (Math.random() < this.epsilon) {
      return randomItem(pool);
    }

    let best = null;
    let bestUcb = -Infinity;
    const logT = Math.log(this.globalTries + 1);

    for (const choice of pool) {
      const s = this.stats.get(this._key(parentSig, choice.op)) || {
        tries: 0,
        rewardSum: 0,
        failures: 0,
        tabu: false
      };
      const ucb =
        s.tries === 0 ? Number.POSITIVE_INFINITY : s.rewardSum / s.tries + Math.sqrt((2 * logT) / s.tries);
      if (ucb > bestUcb) {
        bestUcb = ucb;
        best = choice;
      }
    }
    return best || randomItem(pool);
  }

  record(parentSig, op, reward) {
    const k = this._key(parentSig, op);
    const s = this.stats.get(k) || { tries: 0, rewardSum: 0, failures: 0, tabu: false };
    s.tries += 1;
    s.rewardSum += reward;
    if (reward <= 0) s.failures += 1;
    else s.failures = 0;
    if (s.failures >= this.tabuFailures) s.tabu = true;
    this.stats.set(k, s);
    this.globalTries += 1;
  }

  snapshot() {
    const tabu_count = [...this.stats.values()].filter((s) => s.tabu).length;
    return {
      global_tries: this.globalTries,
      tracked_pairs: this.stats.size,
      tabu_count
    };
  }
}

export function orderParentsByScore(parents, lambda = 0.35, alpha = 0.2) {
  if (!parents?.length) return [];
  const n = parents.length;
  if (n === 1) return [...parents];

  const scores = parents.map((p) => Number(p.score) || 0);
  const maxS = Math.max(...scores);
  const expW = scores.map((s) => Math.exp(alpha * (s - maxS)));
  const sumExp = expW.reduce((a, b) => a + b, 0) || 1;
  const scoreProb = expW.map((w) => w / sumExp);
  const uniform = 1 / n;
  const mixed = scoreProb.map((p) => lambda * uniform + (1 - lambda) * p);

  const indexed = parents.map((p, i) => ({ p, w: mixed[i], r: Math.random() }));
  indexed.sort((a, b) => b.w + b.r * 0.001 - (a.w + a.r * 0.001));
  return indexed.map((x) => x.p);
}

export function isRuleMutationMode(mode) {
  return mode === "rule_bandit" || mode === "rule_random";
}
