/**
 * 从拼装伪代码或 --- id.pseudo --- 块解析各节点伪代码片段。
 */
export function parseNodePseudoMap(pseudocode) {
  const map = {};
  const text = String(pseudocode || "").trim();
  if (!text) return map;

  const blocks = text.split(/---\s+(\S+)\.pseudo\s*---/);
  if (blocks.length > 1) {
    for (let i = 1; i < blocks.length; i += 2) {
      map[blocks[i]] = blocks[i + 1].trim();
    }
    return map;
  }

  let currentId = null;
  let buf = [];
  const flush = () => {
    if (currentId) map[currentId] = buf.join("\n").trim();
    buf = [];
  };

  for (const line of text.split("\n")) {
    const m = line.match(/#\s*\[([^\]]+)\]/);
    if (m) {
      flush();
      currentId = m[1];
      const rest = line.replace(/^.*?#\s*\[[^\]]+\]\s*/, "").trim();
      if (rest) buf.push(rest);
      continue;
    }
    if (currentId) buf.push(line);
  }
  flush();
  return map;
}
