import fs from "fs";
import path from "path";

const DEFAULT_DATASET_PATH = "data/eval_dataset.jsonl";
const DEFAULT_OUTPUT_PATH = "data/optimize_result.json";
const DEFAULT_API_URL = "http://localhost:3001/api/mwgl/optimize";

function readJsonl(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  const text = fs.readFileSync(absolute, "utf8");
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${idx + 1}: ${error.message}`);
      }
    });
}

function loadInitialWorkflow(filePath) {
  if (!filePath) {
    return {
      mwgl_version: 2,
      rule_id: "R_seed_default",
      rule_name: "默认初始流程",
      nodes: [
        { id: "n_start", type: "start", text: "开始", x: 120, y: 180 },
        { id: "n_step_validate", type: "step", text: "校验订单", x: 300, y: 180 },
        { id: "n_end_ok", type: "end", outcome: "success", text: "订单处理成功", x: 520, y: 150 },
        { id: "n_end_fail", type: "end", outcome: "failure", text: "订单未通过-支付异常", x: 520, y: 240 }
      ],
      edges: [
        { id: "e_start_validate", from: "n_start", to: "n_step_validate", label: "" },
        { id: "e_validate_ok", from: "n_step_validate", to: "n_end_ok", label: "" },
        { id: "e_validate_fail", from: "n_step_validate", to: "n_end_fail", label: "" }
      ]
    };
  }
  const absolute = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(absolute, "utf8");
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const result = {
    dataset: DEFAULT_DATASET_PATH,
    output: DEFAULT_OUTPUT_PATH,
    url: DEFAULT_API_URL,
    initialWorkflowPath: "",
    algorithm: "top4"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dataset") result.dataset = argv[++i] || result.dataset;
    else if (arg === "--output") result.output = argv[++i] || result.output;
    else if (arg === "--url") result.url = argv[++i] || result.url;
    else if (arg === "--initial-workflow") result.initialWorkflowPath = argv[++i] || "";
    else if (arg === "--algorithm") result.algorithm = argv[++i] || result.algorithm;
    else if (arg === "--top4-rounds") result.top4Rounds = Number(argv[++i] || result.top4Rounds);
  }

  if (result.top4Rounds !== undefined && (!Number.isFinite(result.top4Rounds) || result.top4Rounds < 1)) {
    throw new Error("--top4-rounds must be a positive number");
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evalDataset = readJsonl(args.dataset);
  const initialWorkflow = loadInitialWorkflow(args.initialWorkflowPath);

  const payload = {
    prompt: "基于样本集优化 MWGL workflow",
    initial_workflow: initialWorkflow,
    eval_dataset: evalDataset,
    config: {
      algorithm: "top4",
      mutation_mode: "llm_generate",
      top4_search_mode: "beam",
      top4_keep: 4,
      top4_rounds: Math.floor(args.top4Rounds || 2),
      top4_mcts_extra_rounds: 1,
      top4_mcts_exploration: 1.2,
      top4_initial_pool: 8,
      top4_children_per_parent: 2,
      retrieval_mode: "faiss",
      eval_topk: 24
    }
  };

  const resp = await fetch(args.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = await resp.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    throw new Error(`Optimize API returned non-JSON: ${text}`);
  }

  if (!resp.ok) {
    throw new Error(`Optimize API failed (${resp.status}): ${JSON.stringify(parsed)}`);
  }

  const outputPath = path.resolve(process.cwd(), args.output);
  fs.writeFileSync(outputPath, JSON.stringify(parsed, null, 2), "utf8");
  console.log(`Optimize done. best_score=${parsed.best_score}`);
  console.log(`Result written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
