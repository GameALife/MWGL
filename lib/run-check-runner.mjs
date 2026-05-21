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

async function writeTempDir() {
  const dir = path.join(os.tmpdir(), `mwgl-${randomBytes(8).toString("hex")}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function removeTempFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    /* ignore */
  }
}

async function removeTempDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function commandMissingError(command, error) {
  return {
    checks: [
      {
        name: "syntax",
        ok: false,
        detail: `未找到命令 ${command}，请安装对应工具链后重试`
      }
    ],
    syntaxOk: false,
    exitCode: 1,
    stdout: "",
    stderr: error?.message || `command not found: ${command}`,
    error: `command not found: ${command}`
  };
}

function syntaxDetail(stderr, ok) {
  const t = stderr?.trim();
  if (t) return t;
  return ok ? "语法通过" : "语法错误";
}

function finalizeCheckResult(r) {
  const passed = r.syntaxOk && r.exitCode === 0;
  return { passed, ...r };
}

async function checkPython(code) {
  const checks = [];
  const filePath = await writeTempFile(".py", code);
  try {
    const syntax = await runCommand("python3", ["-m", "py_compile", filePath], "", 8000);
    checks.push({
      name: "syntax",
      ok: syntax.exitCode === 0,
      detail: syntaxDetail(syntax.stderr, syntax.exitCode === 0)
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
  } catch (error) {
    return commandMissingError("python3", error);
  } finally {
    await removeTempFile(filePath);
  }
}

async function checkJavaScript(code) {
  const checks = [];
  const filePath = await writeTempFile(".mjs", code);
  try {
    let syntaxOk = true;
    let syntaxDetailText = "语法通过";
    try {
      const syntax = await runCommand("node", ["--check", filePath], "", 8000);
      syntaxOk = syntax.exitCode === 0;
      syntaxDetailText = syntax.stderr?.trim() || syntaxDetailText;
      if (!syntaxOk) {
        checks.push({ name: "syntax", ok: false, detail: syntaxDetailText });
        return {
          checks,
          syntaxOk: false,
          exitCode: syntax.exitCode,
          stdout: "",
          stderr: syntax.stderr
        };
      }
    } catch (error) {
      if (error.code === "ENOENT") return commandMissingError("node", error);
      syntaxDetailText = "跳过 node --check（环境不支持）";
    }
    checks.push({ name: "syntax", ok: true, detail: syntaxDetailText });

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

function extractJavaClassName(code) {
  const m = String(code || "").match(/public\s+class\s+(\w+)/);
  return m ? m[1] : "WorkflowApp";
}

async function checkJava(code) {
  const checks = [];
  const className = extractJavaClassName(code);
  const dir = await writeTempDir();
  const filePath = path.join(dir, `${className}.java`);
  try {
    await fs.writeFile(filePath, code, "utf8");
    let compile;
    try {
      compile = await runCommand("javac", [filePath], "", 15000);
    } catch (error) {
      return commandMissingError("javac", error);
    }
    checks.push({
      name: "syntax",
      ok: compile.exitCode === 0,
      detail: syntaxDetail(compile.stderr, compile.exitCode === 0)
    });
    if (compile.exitCode !== 0) {
      return { checks, syntaxOk: false, exitCode: compile.exitCode, stdout: "", stderr: compile.stderr };
    }
    const run = await runCommand("java", ["-cp", dir, className], "", 12000);
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
    await removeTempDir(dir);
  }
}

function normalizeGoSource(code) {
  const trimmed = String(code || "").trim();
  if (!/^package\s+\w+/m.test(trimmed)) {
    return `package main\n\n${trimmed}`;
  }
  return trimmed;
}

async function checkGo(code) {
  const checks = [];
  const body = normalizeGoSource(code);
  const filePath = await writeTempFile(".go", body);
  try {
    let run;
    try {
      run = await runCommand("go", ["run", filePath], "", 20000);
    } catch (error) {
      return commandMissingError("go", error);
    }
    const syntaxOk = run.exitCode === 0;
    checks.push({
      name: "syntax",
      ok: syntaxOk,
      detail: syntaxDetail(run.stderr, syntaxOk)
    });
    if (!syntaxOk) {
      return { checks, syntaxOk: false, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };
    }
    checks.push({ name: "run", ok: true, detail: "运行成功" });
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

async function checkCpp(code) {
  const checks = [];
  const dir = await writeTempDir();
  const srcPath = path.join(dir, "main.cpp");
  const binPath = path.join(dir, "mwgl_out");
  try {
    await fs.writeFile(srcPath, code, "utf8");
    let compile;
    try {
      compile = await runCommand("g++", ["-std=c++17", "-o", binPath, srcPath], "", 15000);
    } catch (error) {
      return commandMissingError("g++", error);
    }
    checks.push({
      name: "syntax",
      ok: compile.exitCode === 0,
      detail: syntaxDetail(compile.stderr, compile.exitCode === 0)
    });
    if (compile.exitCode !== 0) {
      return { checks, syntaxOk: false, exitCode: compile.exitCode, stdout: "", stderr: compile.stderr };
    }
    const run = await runCommand(binPath, [], "", 12000);
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
    await removeTempDir(dir);
  }
}

const CHECK_BY_LANG = {
  Python: checkPython,
  JavaScript: checkJavaScript,
  Java: checkJava,
  Go: checkGo,
  "C++": checkCpp
};

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

  const checker = CHECK_BY_LANG[lang];
  if (!checker) {
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
          detail: `自动运行检测不支持语言：${lang}（支持 Python / JavaScript / Java / Go / C++）`
        }
      ],
      error: `unsupported language: ${lang}`
    };
  }

  const r = await checker(body);
  return finalizeCheckResult(r);
}
