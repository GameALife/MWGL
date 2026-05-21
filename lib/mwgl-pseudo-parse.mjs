/**
 * v3 伪代码包：main.flow + 逐节点 --- id.pseudo --- 块。
 */

const MAIN_FLOW_MARKER = /^#\s*main\.flow\s*$/im;
const NODE_FILES_MARKER = /^#\s*=+\s*逐节点伪代码/i;

export function parsePseudocodeBundle(pseudocode) {
  const text = String(pseudocode || "").trim();
  const empty = { mainFlow: "", nodeFiles: {} };
  if (!text) return empty;

  let mainFlow = "";
  let nodeSection = text;

  const mainIdx = text.search(MAIN_FLOW_MARKER);
  if (mainIdx >= 0) {
    const afterMarker = text.slice(mainIdx).split("\n").slice(1).join("\n");
    const filesIdx = afterMarker.search(NODE_FILES_MARKER);
    const blockEnd = afterMarker.search(/^---\s+\S+\.pseudo\s*---/m);
    let cut = afterMarker.length;
    if (filesIdx >= 0) cut = Math.min(cut, filesIdx);
    if (blockEnd >= 0) cut = Math.min(cut, blockEnd);
    mainFlow = afterMarker.slice(0, cut).trim();
    nodeSection = filesIdx >= 0 ? afterMarker.slice(filesIdx) : afterMarker.slice(cut);
  }

  const nodeFiles = {};
  const blocks = nodeSection.split(/---\s+(\S+)\.pseudo\s*---/);
  if (blocks.length > 1) {
    for (let i = 1; i < blocks.length; i += 2) {
      nodeFiles[blocks[i]] = blocks[i + 1].trim();
    }
  }

  if (!mainFlow && !Object.keys(nodeFiles).length) {
    return { mainFlow: text, nodeFiles: {} };
  }

  return { mainFlow, nodeFiles };
}

export function serializePseudocodeBundle(bundle) {
  const { mainFlow = "", nodeFiles = {} } = bundle || {};
  const parts = ["# main.flow", String(mainFlow).trim(), "", "# ========== 逐节点伪代码 ==========", ""];
  for (const id of Object.keys(nodeFiles).sort()) {
    const body = String(nodeFiles[id] || "").trim();
    if (!body) continue;
    parts.push(`--- ${id}.pseudo ---`, body, "");
  }
  return parts.join("\n").trimEnd();
}

/**
 * 从 v3 包或旧版拼装伪代码解析各节点伪代码片段。
 */
export function parseNodePseudoMap(pseudocode) {
  const { nodeFiles } = parsePseudocodeBundle(pseudocode);
  if (Object.keys(nodeFiles).length) return nodeFiles;

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
    const callM = line.match(/^\s*(?:CALL|SUCCESS|FAILURE)\s+(\S+)/);
    if (callM) {
      flush();
      currentId = callM[1];
      continue;
    }
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
