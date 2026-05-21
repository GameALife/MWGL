import { Router } from "express";
import { runFullCodeCheck } from "../lib/run-check-runner.mjs";

const router = Router();

router.post("/api/mwgl/run-check", async (req, res) => {
  try {
    const code = String(req.body?.code || "");
    const language = String(req.body?.language || "Python").trim();
    if (!code.trim()) return res.status(400).json({ error: "code is required" });

    const result = await runFullCodeCheck(language, code);
    return res.json({
      language,
      passed: result.passed,
      syntaxOk: result.syntaxOk,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      checks: result.checks || [],
      error: result.error || null
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "run check failed" });
  }
});

export default router;
