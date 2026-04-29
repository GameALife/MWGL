import fs from "fs";
import path from "path";

/** 默认使用「种子 + 合成」合并集；仅种子见 `data/eval_dataset.seed.jsonl`，合并脚本见 `scripts/merge-eval-datasets.js` */
const DEFAULT_DATASET_PATH = "data/eval_dataset.full.jsonl";
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
        { id: "n_case_validate", type: "case", text: "校验订单", x: 300, y: 180 },
        { id: "n_success", type: "success", text: "成功结束", x: 520, y: 150 },
        { id: "n_failure", type: "failure", text: "失败结束", x: 520, y: 240 }
      ],
      edges: [
        { id: "e_start_validate", from: "n_start", to: "n_case_validate", label: "" },
        { id: "e_validate_ok", from: "n_case_validate", to: "n_success", label: "已支付" },
        { id: "e_validate_fail", from: "n_case_validate", to: "n_failure", label: "异常" }
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
    algorithm: "mcts",
    iterations: 20
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dataset") result.dataset = argv[++i] || result.dataset;
    else if (arg === "--output") result.output = argv[++i] || result.output;
    else if (arg === "--url") result.url = argv[++i] || result.url;
    else if (arg === "--initial-workflow") result.initialWorkflowPath = argv[++i] || "";
    else if (arg === "--algorithm") result.algorithm = argv[++i] || result.algorithm;
    else if (arg === "--iterations") result.iterations = Number(argv[++i] || result.iterations);
  }

  if (!Number.isFinite(result.iterations) || result.iterations < 1) {
    throw new Error("--iterations must be a positive number");
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
      algorithm: args.algorithm,
      iterations: Math.floor(args.iterations),
      beam_width: 6,
      candidates_per_parent: 4,
      mcts_exploration: 1.2,
      mcts_rollout_steps: 2
    },
    evaluator: {
      url: "http://localhost:3001/api/mwgl/mock-evaluator",
      timeout_ms: 3000,
      pass_through_prompt: true
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
