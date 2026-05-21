/** 仍为系统默认名时可自动根据提示词重命名 */
const AUTO_NAME_RE = /^(窗口|工作流|新窗口|新工作流)(\s*\d+)?$/;

export function isAutoSessionName(name) {
  const n = String(name || "").trim();
  return !n || AUTO_NAME_RE.test(n);
}

/**
 * 从用户提示词提取简短窗口名（首行关键词，最多约 24 字）。
 */
export function deriveSessionNameFromPrompt(prompt) {
  let text = String(prompt || "").trim();
  if (!text) return "新工作流";

  text = text.split(/\r?\n/)[0].trim();
  text = text.replace(/^\d+[\.\、\)]\s*/, "");
  text = text.replace(/^["'「『【]+|["'」』】]+$/g, "");
  text = text.replace(/^(请|帮我|帮忙|实现|设计|创建|生成|做一个|写一?个)\s*/u, "");

  const cleaned = text
    .replace(/[^\u4e00-\u9fff\w\s\-，、：；]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "新工作流";

  let name = (cleaned.split(/[，,。\.；;！!？?]/)[0] || cleaned).trim();
  if (name.length > 24) {
    const latinHeavy = /^[\x00-\x7F\s\-]+$/.test(name.slice(0, 28));
    name = latinHeavy
      ? (name.slice(0, 24).replace(/\s+\S*$/, "").trim() || name.slice(0, 24))
      : name.slice(0, 24);
  }
  return name || "新工作流";
}

export function uniqueSessionName(baseName, existingNames) {
  const used = new Set(existingNames.map((n) => String(n || "").trim()));
  const base = String(baseName || "新工作流").trim() || "新工作流";
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}
