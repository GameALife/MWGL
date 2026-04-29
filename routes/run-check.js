import { Router } from "express";
import { spawn } from "node:child_process";

const router = Router();

function runCommand(command, args, input, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ exitCode: -1, stdout, stderr: `${stderr}\nProcess timed out after ${timeoutMs}ms.`.trim() });
        return;
      }
      resolve({ exitCode: Number(code ?? 1), stdout, stderr });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

router.post("/api/mwgl/run-check", async (req, res) => {
  try {
    const code = String(req.body?.code || "");
    const language = String(req.body?.language || "Python").trim();
    if (!code.trim()) return res.status(400).json({ error: "code is required" });

    if (language === "Python") {
      const result = await runCommand("python3", ["-c", code], "");
      return res.json({ language, ...result });
    }
    if (language === "JavaScript") {
      const result = await runCommand("node", ["-e", code], "");
      return res.json({ language, ...result });
    }

    return res.status(400).json({
      error: `快速自检暂仅支持 Python/JavaScript，当前为 ${language}`
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "run check failed" });
  }
});

export default router;
