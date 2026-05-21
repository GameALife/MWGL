/**
 * 主图画布上 step 节点内嵌循环体预览（loop.steps 树状缩略图）。
 */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(text, max = 28) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function renderSteps(steps, depth, limits) {
  const { maxSteps, maxDepth, maxBranchSteps } = limits;
  if (!Array.isArray(steps) || !steps.length) {
    return '<div class="loop-preview-empty">（循环体为空，点击编辑）</div>';
  }

  const visible = steps.slice(0, maxSteps);
  const hidden = steps.length - visible.length;
  let html = '<div class="loop-preview-flow">';

  for (let i = 0; i < visible.length; i += 1) {
    const step = visible[i];
    if (i > 0) html += '<div class="loop-preview-connector" aria-hidden="true"></div>';
    html += renderStepItem(step, depth, limits);
  }

  if (hidden > 0) {
    html += `<div class="loop-preview-more">+${hidden} 步…</div>`;
  }
  html += "</div>";
  return html;
}

function renderStepItem(step, depth, limits) {
  const type = step?.type || "step";
  const label = truncate(step?.text || type, 24);

  if (type === "step") {
    return `<div class="loop-preview-item loop-preview-step">
      <span class="loop-preview-badge">step</span>
      <span class="loop-preview-label">${escapeHtml(label)}</span>
    </div>`;
  }

  if (type === "loop") {
    const inner =
      depth < limits.maxDepth
        ? renderSteps(step.loop?.steps || [], depth + 1, limits)
        : '<div class="loop-preview-nested-hint">嵌套循环…</div>';
    const cond = truncate(step.loop?.condition || "", 20);
    const kind = step.loop?.kind === "while" ? "while" : "for";
    return `<div class="loop-preview-item loop-preview-nested">
      <div class="loop-preview-nested-head">
        <span class="loop-preview-badge loop-preview-badge-loop">${kind}</span>
        ${cond ? `<span class="loop-preview-cond">${escapeHtml(cond)}</span>` : ""}
      </div>
      <div class="loop-preview-nested-body">${inner}</div>
    </div>`;
  }

  if (type === "branch") {
    const arms = Array.isArray(step.arms) ? step.arms : [];
    const cols = arms
      .slice(0, 3)
      .map((arm) => {
        const armSteps = (arm.steps || []).slice(0, limits.maxBranchSteps);
        const armHidden = (arm.steps || []).length - armSteps.length;
        let body = armSteps
          .map(
            (st) =>
              `<div class="loop-preview-arm-step">${escapeHtml(truncate(st.text || st.type, 16))}</div>`
          )
          .join("");
        if (!body) body = '<div class="loop-preview-arm-step muted">空</div>';
        if (armHidden > 0) {
          body += `<div class="loop-preview-arm-step muted">+${armHidden}</div>`;
        }
        return `<div class="loop-preview-arm">
          <div class="loop-preview-arm-label">${escapeHtml(truncate(arm.label, 10))}</div>
          ${body}
        </div>`;
      })
      .join("");
    return `<div class="loop-preview-item loop-preview-branch">
      <div class="loop-preview-branch-title">${escapeHtml(label)}</div>
      <div class="loop-preview-arms">${cols || '<span class="muted">无分支臂</span>'}</div>
    </div>`;
  }

  if (type === "subflow") {
    return `<div class="loop-preview-item loop-preview-subflow">
      <span class="loop-preview-badge loop-preview-badge-sub">sub</span>
      <span class="loop-preview-label">${escapeHtml(truncate(step.text || step.ref, 22))}</span>
    </div>`;
  }

  return `<div class="loop-preview-item loop-preview-step muted">${escapeHtml(type)}</div>`;
}

/**
 * @param {object|null|undefined} loop
 * @param {{ maxSteps?: number, maxDepth?: number }} [options]
 * @returns {string} HTML 片段（用于 node.innerHTML）
 */
export function buildLoopPreviewHtml(loop, options = {}) {
  if (!loop || typeof loop !== "object") return "";
  const limits = {
    maxSteps: options.maxSteps ?? 6,
    maxDepth: options.maxDepth ?? 3,
    maxBranchSteps: options.maxBranchSteps ?? 3
  };
  const kind = loop.kind === "while" ? "while" : "for";
  const cond = truncate(loop.condition || "", 36);
  const flow = renderSteps(loop.steps || [], 0, limits);
  const stepCount = Array.isArray(loop.steps) ? loop.steps.length : 0;

  return `<div class="loop-preview" title="点击节点编辑循环体">
    <div class="loop-preview-header">
      <span class="loop-preview-kind">${kind}</span>
      ${cond ? `<span class="loop-preview-header-cond">${escapeHtml(cond)}</span>` : ""}
      <span class="loop-preview-count">${stepCount} 步</span>
    </div>
    ${flow}
  </div>`;
}
