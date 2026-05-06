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

const app = express();
const port = Number(process.env.PORT || 3001);
const corsOrigin = process.env.CORS_ORIGIN || "*";

app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((s) => s.trim()) }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasKey: hasKey(), deepseekBase: getBase() });
});

app.use(skill1);
app.use(skill2);
app.use(skill3);
app.use(optimize);
app.use(mockEvaluator);
app.use(evalDatasetRead);
app.use(runCheck);

app.listen(port, () => {
  console.log(`MWGL v2 server listening on http://localhost:${port}`);
});
