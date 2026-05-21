import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

function runCommand(command, args, input = "", timeoutMs = 12000) {
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
        resolve({
          exitCode: -1,
          stdout,
          stderr: `${stderr}\nProcess timed out after ${timeoutMs}ms.`.trim()
        });
        return;
      }
      resolve({ exitCode: Number(code ?? 1), stdout, stderr });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function writeTempFile(ext, content) {
  const dir = os.tmpdir();
  const name = `mwgl-${randomBytes(8).toString("hex")}${ext}`;
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function removeTempFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    /* ignore */
  }
}

async function checkPython(code) {
  const checks = [];
  const filePath = await writeTempFile(".py", code);
  try {
    const syntax = await runCommand("python3", ["-m", "py_compile", filePath], "", 8000);
    checks.push({
      name: "syntax",
      ok: syntax.exitCode === 0,
      detail: syntax.stderr?.trim() || (syntax.exitCode === 0 ? "语法通过" : "语法错误")
    });
    if (syntax.exitCode !== 0) {
      return { checks, syntaxOk: false, exitCode: syntax.exitCode, stdout: "", stderr: syntax.stderr };
    }
    const run = await runCommand("python3", [filePath], "", 12000);
    checks.push({
      name: "run",
      ok: run.exitCode === 0,
      detail: run.exitCode === 0 ? "运行成功" : `退出码 ${run.exitCode}`
    });
    return {
      checks,
      syntaxOk: true,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr
    };
  } finally {
    await removeTempFile(filePath);
  }
}

async function checkJavaScript(code) {
  const checks = [];
  const filePath = await writeTempFile(".mjs", code);
  try {
    let syntaxOk = true;
    let syntaxDetail = "语法通过";
    try {
      const syntax = await runCommand("node", ["--check", filePath], "", 8000);
      syntaxOk = syntax.exitCode === 0;
      syntaxDetail = syntax.stderr?.trim() || syntaxDetail;
      if (!syntaxOk) {
        checks.push({ name: "syntax", ok: false, detail: syntaxDetail });
        return {
          checks,
          syntaxOk: false,
          exitCode: syntax.exitCode,
          stdout: "",
          stderr: syntax.stderr
        };
      }
    } catch {
      syntaxDetail = "跳过 node --check（环境不支持）";
    }
    checks.push({ name: "syntax", ok: true, detail: syntaxDetail });

    const run = await runCommand("node", [filePath], "", 12000);
    checks.push({
      name: "run",
      ok: run.exitCode === 0,
      detail: run.exitCode === 0 ? "运行成功" : `退出码 ${run.exitCode}`
    });
    return {
      checks,
      syntaxOk: true,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr
    };
  } finally {
    await removeTempFile(filePath);
  }
}

/**
 * @returns {Promise<{ passed: boolean, syntaxOk: boolean, exitCode: number, stdout: string, stderr: string, checks: object[], error?: string }>}
 */
export async function runFullCodeCheck(language, code) {
  const lang = String(language || "Python").trim();
  const body = String(code || "").trim();
  if (!body) {
    return {
      passed: false,
      syntaxOk: false,
      exitCode: 1,
      stdout: "",
      stderr: "",
      checks: [{ name: "input", ok: false, detail: "代码为空" }],
      error: "code is empty"
    };
  }

  if (lang === "Python") {
    const r = await checkPython(body);
    const passed = r.syntaxOk && r.exitCode === 0;
    return { passed, ...r };
  }
  if (lang === "JavaScript") {
    const r = await checkJavaScript(body);
    const passed = r.syntaxOk && r.exitCode === 0;
    return { passed, ...r };
  }

  return {
    passed: false,
    syntaxOk: false,
    exitCode: 1,
    stdout: "",
    stderr: "",
    checks: [
      {
        name: "run",
        ok: false,
        detail: `自动运行检测暂支持 Python / JavaScript，当前为 ${lang}`
      }
    ],
    error: `unsupported language: ${lang}`
  };
}
