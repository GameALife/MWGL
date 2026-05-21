/**
 * Top-K 搜索（束搜索 / MCTS 二选一；默认 keep=2、初池=4）：
 * - 第 0 轮：DeepSeek 并行初池 → 保留 top_k（默认 2）
 * - 束搜索（默认）：每轮对 top_k **全部**父代并行 2 次 Qwen（content|structure）→ 子代取 top_k
 * - MCTS：UCT 在搜索树上选点扩两路（无 pool）；轮数 = top4_rounds + top4_mcts_extra_rounds
 * - 全程 globalBest；MCTS 的 history.top 为树上当前 Top-K 快照（仅日志）
 */
import { normalizeWorkflow, validateWorkflowConstraints } from "../js/mwgl.js";
import { generateWorkflowFromPrompt, temperaturesForCount } from "./mwgl-generate-validate.mjs";

export const MUTATION_BRANCHES = [
  {
    id: "content",
    op: "llm_generate_content",
    instruction_zh:
      "【内容优化】在尽量保持现有 DAG 拓扑（节点 id、连边关系）的前提下，优化各 step/branch/end 的 text 与分支 label：" +
      "更贴合用户 prompt 与评测 requirements（输入输出变量、业务语义）；修正含糊或错误的节点文案；" +
      "不要为改文案而大规模删增节点，除非校验错误必须修。"
  },
  {
    id: "structure",
    op: "llm_generate_structure",
    instruction_zh:
      "【结构优化】在保留核心业务语义的前提下，优化 DAG 结构：补全/修正分支臂、成功/失败 end、可达性；" +
      "按需增删 step/branch/end 以满足 needs_branch、needs_loop、终态约束；" +
      "可调整 step 文案，但本轮重点是拓扑与约束合规，而非润色措辞。"
  }
];

function dedupeBySignature(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const sig = JSON.stringify(c.workflow);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(c);
  }
  return out;
}

function summarizeCandidate(c) {
  return {
    id: c.id,
    score: Number(c.score.toFixed(6)),
    op: c.op,
    round: c.round,
    mutation_branch: c.mutation_branch || null,
    mcts_visits: c.mcts_visits ?? undefined,
    metrics: c.metrics
  };
}

function uctValue(parent, child, exploration) {
  if (child.visits === 0) return Number.POSITIVE_INFINITY;
  const exploit = child.rewardSum / child.visits;
  const explore = exploration * Math.sqrt(Math.log(parent.visits + 1) / child.visits);
  return exploit + explore;
}

function createMctsShell(candidate, parent) {
  return {
    id: candidate.id,
    workflow: candidate.workflow,
    score: candidate.score,
    metrics: candidate.metrics,
    op: candidate.op,
    round: candidate.round,
    parent_id: candidate.parent_id,
    mutation_branch: candidate.mutation_branch || null,
    visits: 0,
    rewardSum: 0,
    children: [],
    parent,
    expanded: false
  };
}

function collectScoredNodes(node, out = []) {
  if (node?.workflow && Number.isFinite(node.score)) {
    out.push(node);
  }
  for (const ch of node.children || []) {
    collectScoredNodes(ch, out);
  }
  return out;
}

function selectMctsLeaf(root, exploration) {
  let cur = root;
  while (cur.expanded && cur.children.length > 0) {
    let best = cur.children[0];
    let bestUct = uctValue(cur, best, exploration);
    for (const ch of cur.children.slice(1)) {
      const v = uctValue(cur, ch, exploration);
      if (v > bestUct) {
        bestUct = v;
        best = ch;
      }
    }
    cur = best;
  }
  return cur;
}

function backpropagate(node, reward) {
  let cur = node;
  while (cur) {
    cur.visits += 1;
    cur.rewardSum += reward;
    cur = cur.parent;
  }
}

function mctsNodeToCandidate(node) {
  return {
    id: node.id,
    workflow: node.workflow,
    score: node.score,
    metrics: node.metrics,
    op: node.op,
    round: node.round,
    parent_id: node.parent_id,
    mutation_branch: node.mutation_branch,
    mcts_visits: node.visits
  };
}

function normalizeSearchMode(config) {
  const raw = String(config.top4_search_mode || "beam").trim().toLowerCase();
  return raw === "mcts" ? "mcts" : "beam";
}

/** 图编辑：第 0 轮对种子；第 1+ 轮对父代（找不到父代时回退种子）。 */
function buildEvalContextForJudge(meta, candidateById, baseContext) {
  const ge = baseContext?.graphEditEval;
  if (!ge?.enabled) return baseContext;

  const seedRef = ge.seedReference ?? ge.referenceWorkflow;
  let referenceWorkflow = seedRef;
  let referenceKind = "seed";

  if (meta.round >= 1 && meta.parent_id) {
    const parent = candidateById.get(meta.parent_id);
    if (parent?.workflow) {
      referenceWorkflow = parent.workflow;
      referenceKind = "parent";
    }
  }

  if (!referenceWorkflow) return baseContext;

  return {
    ...baseContext,
    graphEditEval: {
      ...ge,
      referenceWorkflow,
      referenceKind
    }
  };
}

export async function runTop4Search({
  prompt,
  seedWorkflows,
  evalDataset,
  config,
  context,
  evaluateCandidate,
  mutateWorkflow
}) {
  const searchMode = normalizeSearchMode(config);
  const keep = Math.max(1, Math.floor(config.top4_keep || 2));
  const beamRounds = Math.max(1, Math.floor(config.top4_rounds || 2));
  const mctsExtraRounds = Math.max(0, Math.floor(config.top4_mcts_extra_rounds ?? 1));
  const macroRounds = searchMode === "mcts" ? beamRounds + mctsExtraRounds : beamRounds;
  const exploration = Math.max(0.05, Number(config.top4_mcts_exploration) || 1.2);
  const initialPool = Math.max(keep, Math.floor(config.top4_initial_pool || 4));
  const maxNodes = config.max_nodes;
  const history = [];
  const dropped = { generate_failed: 0, mutate_failed: 0, constraint_failed: 0 };
  let globalBest = null;

  const updateGlobalBest = (candidate) => {
    if (!candidate || !Number.isFinite(candidate.score)) return;
    if (!globalBest || candidate.score > globalBest.score) {
      globalBest = candidate;
    }
  };

  let pool = [];
  const candidateById = new Map();
  let idSeq = 0;
  const nextId = (prefix) => {
    idSeq += 1;
    return `${prefix}_${idSeq}`;
  };

  async function judgeWorkflow(workflow, meta) {
    const evalContext = buildEvalContextForJudge(meta, candidateById, context);
    const judged = await evaluateCandidate(workflow, evalDataset, config.weights, evalContext);
    const candidate = { ...judged, ...meta };
    candidateById.set(candidate.id, candidate);
    updateGlobalBest(candidate);
    return candidate;
  }

  async function expandParentWithBranches(parent, round) {
    const mutations = await Promise.all(
      MUTATION_BRANCHES.map(async (branch) => {
        const mutation = await mutateWorkflow(parent.workflow, maxNodes, {
          ...context,
          mutationFocus: branch
        });
        return { branch, mutation };
      })
    );

    const children = [];
    for (const { branch, mutation } of mutations) {
      if (!mutation?.workflow) {
        dropped.mutate_failed += 1;
        continue;
      }
      const normalized = normalizeWorkflow(mutation.workflow);
      const check = validateWorkflowConstraints(normalized);
      if (!check.ok) {
        dropped.constraint_failed += 1;
        continue;
      }
      children.push(
        await judgeWorkflow(normalized, {
          id: nextId(`r${round}_${branch.id}`),
          op: mutation.op || branch.op,
          round,
          parent_id: parent.id,
          mutation_branch: branch.id
        })
      );
    }
    return children;
  }

  const mctsRoot = {
    id: "mcts_root",
    visits: 0,
    rewardSum: 0,
    children: [],
    parent: null,
    expanded: false
  };

  async function expandMctsNode(mctsNode, round) {
    if (mctsNode.expanded || !mctsNode.workflow) return [];
    mctsNode.expanded = true;

    const judgedChildren = await expandParentWithBranches(
      {
        id: mctsNode.id,
        workflow: mctsNode.workflow
      },
      round
    );

    for (const judged of judgedChildren) {
      const childShell = createMctsShell(judged, mctsNode);
      mctsNode.children.push(childShell);
      backpropagate(childShell, judged.score);
    }
    return judgedChildren;
  }

  function topScoredFromTree(limit = keep) {
    const nodes = collectScoredNodes(mctsRoot);
    return dedupeBySignature(nodes.map(mctsNodeToCandidate))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  function attachCandidatesToMctsRoot(candidates) {
    const existing = new Set(mctsRoot.children.map((n) => JSON.stringify(n.workflow)));
    for (const c of candidates) {
      const sig = JSON.stringify(c.workflow);
      if (existing.has(sig)) continue;
      existing.add(sig);
      mctsRoot.children.push(createMctsShell(c, mctsRoot));
    }
  }

  // —— 第 0 轮：种子 + 并行 DeepSeek ——
  const initialCandidates = [];
  for (const wf of seedWorkflows || []) {
    initialCandidates.push(
      await judgeWorkflow(wf, {
        id: nextId("seed"),
        op: "seed",
        round: 0,
        parent_id: null
      })
    );
  }

  const needGen = Math.max(0, initialPool - initialCandidates.length);
  const anchorSeed = (seedWorkflows || [])[0] || null;
  if (needGen > 0) {
    const temps = temperaturesForCount(needGen);
    const results = await Promise.all(
      temps.map((t) =>
        generateWorkflowFromPrompt(prompt, t, {
          seedWorkflow: anchorSeed
        })
      )
    );
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      if (!r.ok || !r.normalized) {
        dropped.generate_failed += 1;
        continue;
      }
      initialCandidates.push(
        await judgeWorkflow(r.normalized, {
          id: nextId("gen"),
          op: "parallel_generate",
          round: 0,
          parent_id: null,
          temperature: temps[i]
        })
      );
    }
  }

  const initialTop = dedupeBySignature(initialCandidates)
    .sort((a, b) => b.score - a.score)
    .slice(0, keep);

  if (context.graphEditEval?.enabled && !context.graphEditEval.seedReference && initialTop.length > 0) {
    context.graphEditEval.seedReference = initialTop[0].workflow;
    if (!context.graphEditEval.referenceWorkflow) {
      context.graphEditEval.referenceWorkflow = initialTop[0].workflow;
    }
  }

  if (searchMode === "mcts") {
    attachCandidatesToMctsRoot(initialTop);
  } else {
    pool = initialTop;
  }

  history.push({
    round: 0,
    phase: "initial_pool",
    search_mode: searchMode,
    ...(searchMode === "mcts"
      ? { tree_top_k: initialTop.length }
      : { pool_size: pool.length }),
    global_best_score: globalBest ? Number(globalBest.score.toFixed(6)) : null,
    global_best_id: globalBest?.id ?? null,
    top: initialTop.map(summarizeCandidate)
  });

  if (initialCandidates.length === 0 || !globalBest) {
    return {
      best: globalBest,
      pool: searchMode === "beam" ? pool : [],
      tree_top: searchMode === "mcts" ? [] : undefined,
      history,
      dropped,
      stoppedEarly: true,
      search_mode: searchMode
    };
  }

  if (searchMode === "beam") {
    for (let r = 1; r <= macroRounds; r += 1) {
      const parents = pool.slice(0, keep);
      const childBatches = await Promise.all(parents.map((parent) => expandParentWithBranches(parent, r)));
      const children = childBatches.flat();

      pool = dedupeBySignature(children)
        .sort((a, b) => b.score - a.score)
        .slice(0, keep);

      history.push({
        round: r,
        phase: "beam",
        search_mode: "beam",
        parents: parents.map((p) => p.id),
        children_attempted: parents.length * MUTATION_BRANCHES.length,
        branches: MUTATION_BRANCHES.map((b) => b.id),
        pool_size: pool.length,
        global_best_score: globalBest ? Number(globalBest.score.toFixed(6)) : null,
        global_best_id: globalBest?.id ?? null,
        top: pool.map(summarizeCandidate)
      });

      if (pool.length === 0) break;
    }
  } else {
    for (let r = 1; r <= macroRounds; r += 1) {
      const mctsIterations = keep;
      let expansions = 0;

      for (let it = 0; it < mctsIterations; it += 1) {
        const leaf = selectMctsLeaf(mctsRoot, exploration);
        if (!leaf.workflow) {
          const pick = mctsRoot.children[it % Math.max(1, mctsRoot.children.length)];
          if (pick && !pick.expanded) {
            await expandMctsNode(pick, r);
            expansions += 1;
          }
          continue;
        }
        if (!leaf.expanded) {
          await expandMctsNode(leaf, r);
          expansions += 1;
        } else if (leaf.children.length > 0) {
          const child = selectMctsLeaf(leaf, exploration);
          if (child.workflow && !child.expanded) {
            await expandMctsNode(child, r);
            expansions += 1;
          } else {
            backpropagate(child.workflow ? child : leaf, (child.score ?? leaf.score) || 0);
          }
        } else {
          backpropagate(leaf, leaf.score || 0);
        }
      }

      const treeTop = topScoredFromTree();

      history.push({
        round: r,
        phase: "mcts",
        search_mode: "mcts",
        mcts_iterations: mctsIterations,
        expansions,
        branches: MUTATION_BRANCHES.map((b) => b.id),
        exploration,
        tree_top_k: treeTop.length,
        global_best_score: globalBest ? Number(globalBest.score.toFixed(6)) : null,
        global_best_id: globalBest?.id ?? null,
        top: treeTop.map(summarizeCandidate)
      });

      if (mctsRoot.children.length === 0) break;
    }
  }

  const treeTop = searchMode === "mcts" ? topScoredFromTree() : [];

  return {
    best: globalBest,
    pool: searchMode === "beam" ? pool : [],
    tree_top: searchMode === "mcts" ? treeTop : undefined,
    history,
    dropped,
    stoppedEarly: searchMode === "beam" ? pool.length === 0 && !globalBest : !globalBest,
    search_mode: searchMode,
    mcts:
      searchMode === "mcts"
        ? {
            macro_rounds: macroRounds,
            extra_rounds: mctsExtraRounds,
            exploration,
            branches: MUTATION_BRANCHES.map((b) => b.id)
          }
        : undefined
  };
}
