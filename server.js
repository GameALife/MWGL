import "./load-env.js";
import express from "express";
import cors from "cors";
import { hasKey, getBase } from "./routes/deepseek.js";
import skill1 from "./routes/skill1-nl2dag.js";
import skill2 from "./routes/skill2-dag2pseudo.js";
import skill3 from "./routes/skill3-pseudo2code.js";
import optimize from "./routes/optimize.js";
import mockEvaluator from "./routes/mock-evaluator.js";
import evalDatasetRead from "./routes/eval-dataset-read.js";
import runCheck from "./routes/run-check.js";
import codeRepair from "./routes/code-repair.js";
import graphEditEval from "./routes/graph-edit-eval.js";
import workflowSuggestions from "./routes/workflow-suggestions.js";

const app = express();
const port = Number(process.env.PORT || 3001);
const corsOrigin = process.env.CORS_ORIGIN || "*";

app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((s) => s.trim()) }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

function hasQwenConfigured() {
  return Boolean(
    String(process.env.QWEN_API_KEY || "").trim() &&
    String(process.env.QWEN_BASE_URL || "").trim()
  );
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasKey: hasKey(),
    hasQwen: hasQwenConfigured(),
    deepseekBase: getBase()
  });
});

app.use(skill1);
app.use(skill2);
app.use(skill3);
app.use(optimize);
app.use(mockEvaluator);
app.use(evalDatasetRead);
app.use(runCheck);
app.use(codeRepair);
app.use(graphEditEval);
app.use(workflowSuggestions);

const server = app.listen(port, () => {
  console.log(`MWGL server listening on http://localhost:${port}`);
  console.log(`Open the UI in your browser: http://localhost:${port}/`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n端口 ${port} 已被占用，前端页面可能已在运行。\n` +
        `请直接在浏览器打开: http://localhost:${port}/\n` +
        `若需重启服务，先结束占用进程，例如: fuser -k ${port}/tcp  或  kill $(lsof -t -i:${port})\n`
    );
    process.exit(1);
  }
  throw err;
});
