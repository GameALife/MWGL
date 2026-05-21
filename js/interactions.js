import {
  buildWorkflowByDeepSeek,
  dagToPseudocode,
  fetchEvalDataset,
  fetchWorkflowSuggestions,
  optimizeWorkflow,
  pseudoToCode,
  repairCodeFromCheck,
  runCodeQuickCheck
} from "./api.js";
import {
  wouldEdgeCreateCycle,
  layoutWorkflowLeftToRight,
  mwglToWorkflow,
  validateWorkflowConstraints,
  workflowToMwgl,
  createEmptyLoop
} from "./mwgl.js";
import { createLoopEditor } from "./loop-editor.js";
import { bindHighlightScroll, syncCodeHighlight, syncPseudoHighlight } from "./node-highlight.js";
import { GEN_MODES, buildIncrementalWorkflowPrompt, getGenModeMeta } from "./gen-modes.js";
import { state, uid } from "./state.js";
import { NODE_LAYOUT_HEIGHT, NODE_LAYOUT_WIDTH, WORLD_HEIGHT, WORLD_WIDTH, screenToUser } from "./viewport.js";

const CODE_REPAIR_MAX_ROUNDS = 2;

export function bindInteractions(elements, renderer) {
  const { setStatus, getSelectedNode, syncEditor, render, applyViewportTransform } = renderer;
  const SVG_NS = "http://www.w3.org/2000/svg";
  let linking = null;
  let panning = null;
  const MIN_SCALE = 0.4;
  const MAX_SCALE = 2.4;
  const SESSION_STORAGE_KEY = "mwgl_sessions_v1";
  let sessions = [];
  let activeSessionId = "";

  function createBlankWorkflow() {
    return {
      mwgl_version: 3,
      rule_id: uid("R_"),
      rule_name: "空白工作流",
      nodes: [],
      edges: []
    };
  }

  function cloneWorkflow(wf) {
    return JSON.parse(JSON.stringify(wf || state.workflow));
  }

  function newSessionName(index) {
    return `窗口 ${index}`;
  }

  function createSessionPayload(name = "新窗口") {
    return {
      id: uid("s_"),
      name,
      prompt: "",
      workflow: createBlankWorkflow(),
      undoStack: [],
      redoStack: [],
      pseudocode: "",
      code: "",
      codeLanguage: elements.codeLanguage?.value || "Python",
      runResult: ""
    };
  }

  function getActiveSession() {
    return sessions.find((s) => s.id === activeSessionId) || null;
  }

  function cloneWorkflowSnapshot() {
    return cloneWorkflow(state.workflow);
  }

  function updateHistoryButtons() {
    const cur = getActiveSession();
    const undoCount = Array.isArray(cur?.undoStack) ? cur.undoStack.length : 0;
    const redoCount = Array.isArray(cur?.redoStack) ? cur.redoStack.length : 0;
    if (elements.btnUndoWorkflow) {
      elements.btnUndoWorkflow.disabled = undoCount === 0;
      elements.btnUndoWorkflow.title =
        undoCount > 0
          ? `后退一步（Ctrl+Z），还可后退 ${undoCount} 步`
          : "暂无可后退的编辑";
    }
    if (elements.btnRedoWorkflow) {
      elements.btnRedoWorkflow.disabled = redoCount === 0;
      elements.btnRedoWorkflow.title =
        redoCount > 0
          ? `前进一步（Ctrl+Y / Cmd+Shift+Z），还可前进 ${redoCount} 步`
          : "暂无可前进的编辑";
    }
    if (elements.historyHint) {
      elements.historyHint.textContent = `可后退 ${undoCount} · 可前进 ${redoCount}`;
    }
  }

  function recordWorkflowCheckpoint() {
    const cur = getActiveSession();
    if (!cur) return;
    if (!Array.isArray(cur.undoStack)) cur.undoStack = [];
    if (!Array.isArray(cur.redoStack)) cur.redoStack = [];
    cur.undoStack.push(cloneWorkflowSnapshot());
    if (cur.undoStack.length > 80) cur.undoStack = cur.undoStack.slice(-80);
    cur.redoStack = [];
    updateHistoryButtons();
    persistSessions();
  }

  function applyWorkflowSnapshot(snapshot) {
    state.workflow = cloneWorkflow(snapshot || createBlankWorkflow());
    state.selectedNodeId = state.workflow.nodes[0]?.id || null;
    state.selectedEdgeId = null;
    state.pendingCenterViewport = true;
    render();
  }

  function undoWorkflowChange() {
    const cur = getActiveSession();
    if (!cur || !Array.isArray(cur.undoStack) || cur.undoStack.length === 0) {
      setStatus("没有可后退的编辑记录。", true);
      return;
    }
    if (!Array.isArray(cur.redoStack)) cur.redoStack = [];
    const previous = cur.undoStack.pop();
    cur.redoStack.push(cloneWorkflowSnapshot());
    applyWorkflowSnapshot(previous);
    persistActiveSessionNow();
    updateHistoryButtons();
    setStatus(`已后退一步（还可后退 ${cur.undoStack.length} 步）。`);
  }

  function redoWorkflowChange() {
    const cur = getActiveSession();
    if (!cur || !Array.isArray(cur.redoStack) || cur.redoStack.length === 0) {
      setStatus("没有可前进的编辑记录。", true);
      return;
    }
    if (!Array.isArray(cur.undoStack)) cur.undoStack = [];
    const next = cur.redoStack.pop();
    cur.undoStack.push(cloneWorkflowSnapshot());
    applyWorkflowSnapshot(next);
    persistActiveSessionNow();
    updateHistoryButtons();
    setStatus(`已前进一步（还可前进 ${cur.redoStack.length} 步）。`);
  }

  function saveCurrentSessionSnapshot() {
    const cur = sessions.find((s) => s.id === activeSessionId);
    if (!cur) return;
    if (elements.sessionTitle) {
      cur.name = String(elements.sessionTitle.value || "").trim() || cur.name;
    }
    cur.prompt = elements.userPrompt.value || "";
    cur.workflow = cloneWorkflow(state.workflow);
    cur.pseudocode = elements.pseudocodeText.value || "";
    cur.code = elements.codeText.value || "";
    cur.codeLanguage = elements.codeLanguage.value || "Python";
    cur.runResult = elements.runResultText.value || "";
  }

  function persistSessions() {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ activeSessionId, sessions }));
    } catch {
      /* ignore storage error */
    }
  }

  function renderSessionList() {
    const listEl = elements.sessionList;
    if (!listEl) return;
    listEl.innerHTML = "";
    sessions.forEach((session) => {
      const item = document.createElement("div");
      item.className = `session-item${session.id === activeSessionId ? " active" : ""}`;
      const name = document.createElement("span");
      name.className = "session-name";
      name.textContent = session.name;
      name.addEventListener("click", () => switchSession(session.id));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "session-delete";
      del.title = "删除";
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSessionById(session.id);
      });
      item.append(name, del);
      listEl.appendChild(item);
    });
  }

  function applySession(session) {
    state.workflow = cloneWorkflow(session.workflow);
    state.selectedNodeId = state.workflow.nodes[0]?.id || null;
    state.selectedEdgeId = null;
    state.pendingCenterViewport = true;
    if (elements.sessionTitle) elements.sessionTitle.value = session.name || "";
    elements.userPrompt.value = session.prompt || "";
    elements.pseudocodeText.value = session.pseudocode || "";
    elements.codeText.value = session.code || "";
    elements.codeLanguage.value = session.codeLanguage || "Python";
    elements.runResultText.value = session.runResult || "";
    state.pseudocode = session.pseudocode || "";
    state.code = session.code || "";
    document.title = `${session.name || "工作流"} - MWGL Studio v3`;
    render();
    renderSessionList();
    updateHistoryButtons();
    syncGenModeUi();
  }

  function switchSession(nextId) {
    if (!nextId || nextId === activeSessionId) return;
    saveCurrentSessionSnapshot();
    activeSessionId = nextId;
    const target = sessions.find((s) => s.id === nextId);
    if (!target) return;
    applySession(target);
    persistSessions();
    setStatus(`已切换到${target.name}。`);
  }

  function deleteSessionById(sessionId) {
    if (sessions.length <= 1) {
      setStatus("至少保留一个工作流。", true);
      return;
    }
    const target = sessions.find((s) => s.id === sessionId);
    if (!target) return;
    if (!confirm(`确定删除「${target.name}」吗？`)) return;
    const wasActive = activeSessionId === sessionId;
    sessions = sessions.filter((s) => s.id !== sessionId);
    if (wasActive) {
      activeSessionId = sessions[0].id;
      applySession(sessions[0]);
    } else {
      renderSessionList();
    }
    persistSessions();
    updateHistoryButtons();
    setStatus(wasActive ? `已删除「${target.name}」。` : `已删除「${target.name}」。`);
  }

  function persistActiveSessionNow() {
    saveCurrentSessionSnapshot();
    persistSessions();
  }

  function bootstrapSessions() {
    let loaded = null;
    try {
      loaded = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "null");
    } catch {
      loaded = null;
    }
    const loadedSessions = Array.isArray(loaded?.sessions) ? loaded.sessions : [];
    sessions = loadedSessions.length
      ? loadedSessions.map((s, idx) => ({
          id: String(s.id || uid("s_")),
          name: String(s.name || newSessionName(idx + 1)),
          prompt: String(s.prompt || ""),
          workflow: cloneWorkflow(s.workflow || createBlankWorkflow()),
          undoStack: Array.isArray(s.undoStack) ? s.undoStack.map((wf) => cloneWorkflow(wf)) : [],
          redoStack: Array.isArray(s.redoStack) ? s.redoStack.map((wf) => cloneWorkflow(wf)) : [],
          pseudocode: String(s.pseudocode || ""),
          code: String(s.code || ""),
          codeLanguage: String(s.codeLanguage || "Python"),
          runResult: String(s.runResult || "")
        }))
      : [createSessionPayload(newSessionName(1))];
    activeSessionId = String(loaded?.activeSessionId || sessions[0].id);
    if (!sessions.some((s) => s.id === activeSessionId)) activeSessionId = sessions[0].id;
    applySession(sessions.find((s) => s.id === activeSessionId));
    persistSessions();
  }

  async function checkApiStatus() {
    const indicator = document.getElementById("apiStatus");
    const textEl = document.getElementById("apiStatusText");
    if (!indicator || !textEl) return;
    try {
      const base = String(elements.apiBase?.value || "").trim().replace(/\/$/, "");
      if (!base) throw new Error("未配置后端地址");
      const res = await fetch(`${base}/api/health`);
      const data = await res.json();
      if (data.ok) {
        indicator.className = "status-indicator online";
        textEl.textContent = data.hasKey ? "API 已连接" : "未配置密钥";
      } else {
        throw new Error("API 异常");
      }
    } catch {
      indicator.className = "status-indicator offline";
      textEl.textContent = "连接失败";
    }
  }

  function initTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        const panel = document.getElementById(`tab-${btn.dataset.tab}`);
        if (panel) panel.classList.add("active");
        const tab = btn.dataset.tab;
        if (tab === "pseudo") syncPseudoHighlight(elements, state.workflow);
        if (tab === "code") syncCodeHighlight(elements, state.workflow);
      });
    });
  }

  function formatRunCheckResult(result) {
    const checks = (result.checks || [])
      .map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
      .join("\n");
    return [
      result.passed ? "【通过】运行检测成功" : "【未通过】运行检测失败",
      `language: ${result.language}`,
      `syntaxOk: ${result.syntaxOk}`,
      `exitCode: ${result.exitCode}`,
      "",
      "检查项:",
      checks || "(无)",
      "",
      "stdout:",
      String(result.stdout || "").trim() || "(empty)",
      "",
      "stderr:",
      String(result.stderr || "").trim() || "(empty)"
    ].join("\n");
  }

  function updateRunCheckUI(result) {
    if (elements.runCheckSummary) {
      elements.runCheckSummary.classList.remove("hidden", "pass", "fail");
      elements.runCheckSummary.classList.add(result.passed ? "pass" : "fail");
      elements.runCheckSummary.textContent = result.passed
        ? "运行检测通过：语法校验与执行均正常。"
        : `运行检测未通过（退出码 ${result.exitCode}）。可查看日志或点击「根据报错修复」再次尝试。`;
    }
    if (elements.codeCheckBadge) {
      elements.codeCheckBadge.classList.remove("hidden", "pass", "fail");
      elements.codeCheckBadge.classList.add(result.passed ? "pass" : "fail");
      elements.codeCheckBadge.textContent = result.passed ? "✓ 运行检测通过" : "✗ 运行检测未通过";
    }
  }

  async function runCodeCheckAndReport({ silent = false } = {}) {
    const base = elements.apiBase.value.trim().replace(/\/$/, "");
    const code = elements.codeText.value.trim();
    const language = elements.codeLanguage.value;
    if (!code) {
      if (!silent) setStatus("请先生成或输入代码。", true);
      return null;
    }
    if (!silent) setStatus(`正在运行 ${language} 检测（语法 + 执行）...`);
    try {
      const result = await runCodeQuickCheck({ base, code, language });
      const output = formatRunCheckResult(result);
      elements.runResultText.value = output;
      updateRunCheckUI(result);
      saveCurrentSessionSnapshot();
      persistSessions();
      if (!silent) {
        setStatus(
          result.passed ? "运行检测通过。" : "运行检测未通过，请查看运行日志。",
          !result.passed
        );
      }
      return result;
    } catch (error) {
      if (!silent) setStatus(`运行检测失败：${error.message}`, true);
      return null;
    }
  }

  async function repairCodeOnce(checkResult, { round = 1, silent = false } = {}) {
    const base = elements.apiBase.value.trim().replace(/\/$/, "");
    const code = elements.codeText.value.trim();
    const language = elements.codeLanguage.value;
    const pseudocode = elements.pseudocodeText?.value?.trim() || "";
    if (!code || !checkResult) return null;
    if (!silent) {
      setStatus(`正在根据报错修复代码（第 ${round}/${CODE_REPAIR_MAX_ROUNDS} 轮）...`);
    }
    const fixed = await repairCodeFromCheck({
      base,
      code,
      language,
      checkResult,
      pseudocode,
      round,
      maxRounds: CODE_REPAIR_MAX_ROUNDS
    });
    state.code = fixed;
    elements.codeText.value = fixed;
    syncCodeHighlight(elements, state.workflow);
    persistActiveSessionNow();
    return fixed;
  }

  /** 检测未通过时自动把报错回传 LLM 修复，最多 CODE_REPAIR_MAX_ROUNDS 轮 */
  async function runCodeCheckWithAutoRepair({ silent = false } = {}) {
    let lastCheck = await runCodeCheckAndReport({ silent });
    if (!lastCheck || lastCheck.passed) return lastCheck;

    const base = elements.apiBase.value.trim().replace(/\/$/, "");
    if (!base) return lastCheck;

    for (let round = 1; round <= CODE_REPAIR_MAX_ROUNDS; round += 1) {
      if (!silent) {
        setStatus(`检测未通过，正在根据报错请 LLM 修复（${round}/${CODE_REPAIR_MAX_ROUNDS}）...`);
      }
      try {
        await repairCodeOnce(lastCheck, { round, silent: true });
      } catch (error) {
        if (!silent) setStatus(`代码修复失败：${error.message}`, true);
        return lastCheck;
      }
      lastCheck = await runCodeCheckAndReport({ silent: true });
      if (!lastCheck) return lastCheck;
      if (lastCheck.passed) {
        if (!silent) setStatus(`修复后运行检测通过（第 ${round} 轮修复）。`);
        return lastCheck;
      }
    }

    if (!silent) {
      setStatus(
        `已尝试 ${CODE_REPAIR_MAX_ROUNDS} 轮自动修复，仍未通过检测，请查看运行日志或手动修改。`,
        true
      );
    }
    return lastCheck;
  }

  async function repairCodeFromLastFailure() {
    if (!elements.codeText.value.trim()) {
      return setStatus("请先生成或输入代码。", true);
    }
    await runCodeCheckWithAutoRepair();
    document.querySelector('.tab-btn[data-tab="log"]')?.click();
  }

  const selectPostOptimizeEl = document.getElementById("selectPostOptimize");
  const selectTop4SearchModeEl = document.getElementById("selectTop4SearchMode");
  const optimizeHintEl = document.getElementById("optimizeHint");
  const humanReviewPanelEl = document.getElementById("humanReviewPanel");
  const humanReviewPhase1El = document.getElementById("humanReviewPhase1");
  const humanReviewPhase2El = document.getElementById("humanReviewPhase2");
  const humanReviewLeadEl = document.getElementById("humanReviewLead");
  const humanReviewListEl = document.getElementById("humanReviewList");
  const humanReviewFinalInputEl = document.getElementById("humanReviewFinalInput");
  const hrStep1BadgeEl = document.getElementById("hrStep1Badge");
  const hrStep2BadgeEl = document.getElementById("hrStep2Badge");
  const btnFinishInitialEditEl = document.getElementById("btnFinishInitialEdit");
  const btnContinueOptimizeEl = document.getElementById("btnContinueOptimize");
  const humanReviewToolbarEl = document.getElementById("humanReviewToolbar");
  const humanReviewToolbarLabelEl = document.getElementById("humanReviewToolbarLabel");
  const btnFinishInitialEditToolbarEl = document.getElementById("btnFinishInitialEditToolbar");
  const btnContinueOptimizeToolbarEl = document.getElementById("btnContinueOptimizeToolbar");
  const selectGenModeEl = document.getElementById("selectGenMode");
  const genModeHintEl = document.getElementById("genModeHint");
  let pendingTop2Optimize = null;
  let humanReviewPhase = null;

  function syncOptimizeUi() {
    const enabled = selectPostOptimizeEl?.value === "top4";
    if (selectTop4SearchModeEl) {
      selectTop4SearchModeEl.disabled = !enabled;
    }
    if (!optimizeHintEl) return;
    if (!enabled) {
      optimizeHintEl.textContent = "";
      return;
    }
    const mcts = selectTop4SearchModeEl?.value === "mcts";
    optimizeHintEl.textContent = mcts
      ? "Top-2：重新生成工作流后须 ① 初次修改 → ② 最终确认，再补初稿并 MCTS（需 QWEN_*）。"
      : "Top-2：重新生成工作流后须 ① 初次修改 → ② 最终确认，再补初稿并束搜索（需 QWEN_*）。";
  }

  function syncHumanReviewToolbar(phase) {
    const active = humanReviewPanelEl && !humanReviewPanelEl.classList.contains("hidden");
    humanReviewToolbarEl?.classList.toggle("hidden", !active);
    if (!active) return;
    const isInitial = phase === "initial";
    btnFinishInitialEditToolbarEl?.classList.toggle("hidden", !isInitial);
    btnContinueOptimizeToolbarEl?.classList.toggle("hidden", isInitial);
    if (humanReviewToolbarLabelEl) {
      humanReviewToolbarLabelEl.textContent = isInitial
        ? "Top-2 · ① 改完画布点「确认初次修改」"
        : "Top-2 · ② 填意见后点「开始 Top-2」";
    }
  }

  function setHumanReviewStepUi(phase) {
    humanReviewPhase = phase;
    hrStep1BadgeEl?.classList.toggle("hr-step-active", phase === "initial");
    hrStep1BadgeEl?.classList.toggle("hr-step-done", phase === "confirm");
    hrStep2BadgeEl?.classList.toggle("hr-step-active", phase === "confirm");
    hrStep2BadgeEl?.classList.toggle("hr-step-done", false);
    humanReviewPhase1El?.classList.toggle("hidden", phase !== "initial");
    humanReviewPhase2El?.classList.toggle("hidden", phase !== "confirm");
    syncHumanReviewToolbar(phase);
  }

  function hideHumanReviewPanel() {
    pendingTop2Optimize = null;
    humanReviewPhase = null;
    humanReviewPanelEl?.classList.add("hidden");
    humanReviewToolbarEl?.classList.add("hidden");
    if (humanReviewListEl) humanReviewListEl.innerHTML = "";
    if (humanReviewFinalInputEl) humanReviewFinalInputEl.value = "";
    setHumanReviewStepUi("initial");
  }

  function buildOptimizePrompt(originalPrompt, finalNotes) {
    const base = String(originalPrompt || "").trim();
    const notes = String(finalNotes || "").trim();
    if (!notes) return base || "MWGL 工作流优化";
    if (!base) return notes;
    return `${base}\n\n【用户对首图的最终补充意见】\n${notes}`;
  }

  function showHumanReviewPhaseInitial() {
    if (!humanReviewPanelEl) return;
    humanReviewPanelEl.classList.remove("hidden");
    setHumanReviewStepUi("initial");
    requestAnimationFrame(() => {
      humanReviewPanelEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  function renderHumanReviewReferenceList(data) {
    if (!humanReviewListEl) return;
    humanReviewListEl.innerHTML = "";
    const items = (data?.items || []).filter((x) => x.kind !== "intro");
    if (!items.length) {
      const li = document.createElement("li");
      li.textContent = "暂无额外参考项。";
      humanReviewListEl.appendChild(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item.text;
      humanReviewListEl.appendChild(li);
    }
  }

  async function loadHumanReviewSuggestions(workflow, prompt, base) {
    try {
      const evalDataset = await fetchEvalDataset({ base });
      const data = await fetchWorkflowSuggestions({
        base,
        workflow,
        prompt,
        evalDataset
      });
      renderHumanReviewReferenceList(data);
    } catch (err) {
      renderHumanReviewReferenceList({
        items: [{ kind: "warn", text: `参考项加载失败：${String(err.message || err)}` }]
      });
    }
  }

  async function finishInitialEditPhase() {
    if (!pendingTop2Optimize) return;
    const { base, prompt } = pendingTop2Optimize;
    const errs = constraintErrors(state.workflow);
    if (errs.length) {
      return setStatus(
        `请先修复约束错误再进入最终确认：${formatConstraintErrors(errs)}`,
        true
      );
    }
    setHumanReviewStepUi("confirm");
    if (humanReviewFinalInputEl) humanReviewFinalInputEl.value = "";
    humanReviewPanelEl?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    loadHumanReviewSuggestions(state.workflow, prompt, base);
    setStatus(
      "【第二步】在画布上方蓝条填写补充意见，点击「确认意见并开始 Top-2」（或工具栏「开始 Top-2」）。",
      false
    );
  }

  function startHumanReviewAfterGenerate(workflow, prompt, base, searchMode) {
    pendingTop2Optimize = { base, prompt, searchMode, originalPrompt: prompt };
    showHumanReviewPhaseInitial();
    setStatus(
      "首图已生成。① 在画布改图 → 点蓝条或工具栏绿色「确认初次修改」；② 填意见 → 点「确认意见并开始 Top-2」。",
      false
    );
  }

  async function continueTop2Optimize() {
    if (!pendingTop2Optimize) return;
    if (humanReviewPhase !== "confirm") {
      return setStatus("请先完成「初次修改」并进入「最终确认」。", true);
    }
    const { base, prompt, searchMode, originalPrompt } = pendingTop2Optimize;
    const finalNotes = humanReviewFinalInputEl?.value?.trim() || "";
    const optimizePrompt = buildOptimizePrompt(originalPrompt || prompt, finalNotes);
    const modeLabel = searchMode === "mcts" ? "MCTS" : "束搜索";
    const errs = constraintErrors(state.workflow);
    if (errs.length) {
      return setStatus(
        `请先修复约束错误再继续 Top-2：${formatConstraintErrors(errs)}`,
        true
      );
    }
    hideHumanReviewPanel();
    setStatus(`正在 Top-2 ${modeLabel}（以当前图为种子，补 3 张初稿并搜索，需 Qwen）...`);
    try {
      const evalDataset = await fetchEvalDataset({ base });
      const workflow = await optimizeWorkflow({
        base,
        workflow: state.workflow,
        prompt: optimizePrompt,
        evalDataset,
        top4SearchMode: searchMode
      });
      recordWorkflowCheckpoint();
      state.workflow = workflow;
      state.selectedNodeId = state.workflow.nodes[0]?.id || null;
      state.selectedEdgeId = null;
      state.pendingCenterViewport = true;
      render();
      persistActiveSessionNow();
      const afterErrs = constraintErrors(workflow);
      const notesHint = finalNotes ? "（已纳入你的补充意见）" : "";
      const msg = afterErrs.length
        ? `Top-2 已完成${notesHint}（草稿态）：${formatConstraintErrors(afterErrs)}`
        : `Top-2 优化已完成并更新画布${notesHint}。`;
      setStatus(msg, Boolean(afterErrs.length));
      if (finalNotes && elements.userPrompt) {
        elements.userPrompt.value = optimizePrompt;
        saveCurrentSessionSnapshot();
        persistSessions();
      }
    } catch (optErr) {
      setStatus(`Top-2 ${modeLabel} 失败：${optErr.message}`, true);
    }
  }

  if (selectPostOptimizeEl) {
    let savedOpt = localStorage.getItem("mwgl_post_optimize");
    if (savedOpt === null) {
      const legacy = localStorage.getItem("mwgl_post_mcts");
      savedOpt = legacy === "0" ? "none" : "top4";
    }
    if (savedOpt === "beam" || savedOpt === "mcts") savedOpt = "top4";
    if (savedOpt === "none" || savedOpt === "top4") {
      selectPostOptimizeEl.value = savedOpt;
    }
    selectPostOptimizeEl.addEventListener("change", () => {
      localStorage.setItem("mwgl_post_optimize", selectPostOptimizeEl.value);
      syncOptimizeUi();
      syncGenModeUi();
    });
  }
  if (selectTop4SearchModeEl) {
    const savedMode = localStorage.getItem("mwgl_top4_search_mode");
    if (savedMode === "beam" || savedMode === "mcts") {
      selectTop4SearchModeEl.value = savedMode;
    }
    selectTop4SearchModeEl.addEventListener("change", () => {
      localStorage.setItem("mwgl_top4_search_mode", selectTop4SearchModeEl.value);
      syncOptimizeUi();
    });
  }
  syncOptimizeUi();

  function getGenMode() {
    const v = selectGenModeEl?.value;
    return v && GEN_MODES[v] ? v : "regen_workflow";
  }

  function syncGenModeUi() {
    const mode = getGenMode();
    const meta = getGenModeMeta(mode);
    if (genModeHintEl) {
      genModeHintEl.textContent = meta.hint;
    }
    const btnGen = document.getElementById("btnGenerate");
    if (btnGen) {
      btnGen.textContent = `🚀 ${meta.label}`;
    }
  }

  if (selectGenModeEl) {
    const savedMode = localStorage.getItem("mwgl_gen_mode");
    if (savedMode && GEN_MODES[savedMode]) selectGenModeEl.value = savedMode;
    selectGenModeEl.addEventListener("change", () => {
      localStorage.setItem("mwgl_gen_mode", selectGenModeEl.value);
      syncGenModeUi();
    });
  }
  syncGenModeUi();

  function requireGenModeTarget(target, actionLabel) {
    const mode = getGenMode();
    const meta = getGenModeMeta(mode);
    if (meta.target !== target) {
      setStatus(`当前方式为「${meta.label}」，请切换操作方式或点击对应按钮。`, true);
      return false;
    }
    return true;
  }

  function getRevisionNotes() {
    return elements.userPrompt.value.trim();
  }

  function constraintErrors(workflow) {
    const result = validateWorkflowConstraints(workflow);
    return result.ok ? [] : result.errors;
  }

  function formatConstraintErrors(errors) {
    if (!errors?.length) return "";
    return errors.map((msg, idx) => `${idx + 1}. ${msg}`).join(" | ");
  }

  function guessLabelForEdge(fromId) {
    const fromNode = state.workflow.nodes.find((n) => n.id === fromId);
    if (!fromNode) return "";
    const labels = new Set(
      (state.workflow.edges || [])
        .filter((e) => e.from === fromId)
        .map((e) => String(e.label || "").trim())
        .filter(Boolean)
    );
    if (fromNode.type === "branch") {
      if (!labels.has("是")) return "是";
      if (!labels.has("否")) return "否";
      for (let i = 3; i <= 99; i += 1) {
        const opt = `条件${i}`;
        if (!labels.has(opt)) return opt;
      }
      return `条件_${uid("").slice(-4)}`;
    }
    if (fromNode.type === "parallel") {
      for (let i = 0; i < 26; i += 1) {
        const letter = String.fromCharCode(65 + i);
        const opt = `并行分支${letter}`;
        if (!labels.has(opt)) return opt;
      }
      return `并行分支_${uid("").slice(-4)}`;
    }
    return "";
  }

  function focusEdgeLabelInput() {
    const el = elements.edgeLabel;
    if (!el || typeof el.focus !== "function") return;
    el.focus();
    if (typeof el.select === "function") el.select();
  }

  const defaultTextForType = {
    start: "开始",
    step: "执行业务步骤",
    branch: "条件判断",
    parallel: "并行分支",
    end_success: "任务完成",
    end_failure: "任务未达成-条件不满足"
  };

  function addForLoopNode() {
    recordWorkflowCheckpoint();
    const node = {
      id: uid(),
      type: "step",
      text: "for 循环",
      x: Math.round(-120 + Math.random() * 240),
      y: Math.round(-100 + Math.random() * 200),
      loop: createEmptyLoop("for", "")
    };
    state.workflow.nodes.push(node);
    state.selectedNodeId = node.id;
    state.selectedEdgeId = null;
    render();
    persistActiveSessionNow();
    loopEditor?.openForNode(node.id);
  }

  function addNode(typeOrKind) {
    recordWorkflowCheckpoint();
    let type = typeOrKind;
    let outcome;
    if (typeOrKind === "end_success") {
      type = "end";
      outcome = "success";
    } else if (typeOrKind === "end_failure") {
      type = "end";
      outcome = "failure";
    }

    if (type === "branch" || type === "parallel") {
      const x = 120 + Math.floor(Math.random() * 220);
      const y = 120 + Math.floor(Math.random() * 260);
      const isParallel = type === "parallel";
      const fork = {
        id: uid(),
        type,
        text: defaultTextForType[type],
        x,
        y
      };
      const s1 = {
        id: uid(),
        type: "step",
        text: isParallel ? "并行臂步骤A" : "分支步骤A",
        x: x + 280,
        y: y - 48
      };
      const s2 = {
        id: uid(),
        type: "step",
        text: isParallel ? "并行臂步骤B" : "分支步骤B",
        x: x + 280,
        y: y + 48
      };
      const nodesToAdd = [fork, s1, s2];
      const edgesToAdd = [
        {
          id: uid("e"),
          from: fork.id,
          to: s1.id,
          label: isParallel ? "并行分支A" : "是"
        },
        {
          id: uid("e"),
          from: fork.id,
          to: s2.id,
          label: isParallel ? "并行分支B" : "否"
        }
      ];
      if (isParallel) {
        const join = {
          id: uid(),
          type: "step",
          text: "汇总并行结果",
          x: x + 560,
          y
        };
        const endNode = {
          id: uid(),
          type: "end",
          outcome: "success",
          text: "完成",
          x: x + 840,
          y
        };
        nodesToAdd.push(join, endNode);
        edgesToAdd.push(
          { id: uid("e"), from: s1.id, to: join.id, label: "" },
          { id: uid("e"), from: s2.id, to: join.id, label: "" },
          { id: uid("e"), from: join.id, to: endNode.id, label: "" }
        );
      }
      state.workflow.nodes.push(...nodesToAdd);
      state.workflow.edges = state.workflow.edges || [];
      state.workflow.edges.push(...edgesToAdd);
      state.selectedNodeId = fork.id;
      state.selectedEdgeId = null;
      layoutWorkflowLeftToRight(state.workflow);
      state.pendingCenterViewport = true;
      render();
      persistActiveSessionNow();
      return;
    }

    const node = {
      id: uid(),
      type,
      text: defaultTextForType[typeOrKind] || defaultTextForType.step,
      x: Math.round(-120 + Math.random() * 240),
      y: Math.round(-100 + Math.random() * 200)
    };
    if (type === "end") {
      node.outcome = outcome || "success";
    }
    state.workflow.nodes.push(node);
    state.selectedNodeId = node.id;
    state.selectedEdgeId = null;
    state.workflow.edges = state.workflow.edges || [];
    render();
    persistActiveSessionNow();
  }

  function saveEditorToNode() {
    const node = getSelectedNode();
    if (!node) return;
    recordWorkflowCheckpoint();
    const nextType = elements.nodeType.value;
    node.type = nextType;
    node.text = elements.nodeText.value.trim() || "未命名节点";
    if (nextType === "end") {
      node.outcome = elements.nodeOutcome?.value === "failure" ? "failure" : "success";
    } else if (Object.prototype.hasOwnProperty.call(node, "outcome")) {
      delete node.outcome;
    }
    node.x = Number(elements.nodeX.value || 0);
    node.y = Number(elements.nodeY.value || 0);
    render();
    persistActiveSessionNow();
  }

  function deleteNodeById(nodeId) {
    if (!nodeId) return false;
    const before = state.workflow.nodes.length;
    recordWorkflowCheckpoint();
    const removedId = nodeId;
    state.workflow.nodes = state.workflow.nodes.filter((n) => n.id !== nodeId);
    state.workflow.edges = (state.workflow.edges || []).filter((e) => e.from !== removedId && e.to !== removedId);
    if (state.workflow.nodes.length === before) return false;
    state.selectedNodeId = state.workflow.nodes[0] ? state.workflow.nodes[0].id : null;
    state.selectedEdgeId = null;
    render();
    persistActiveSessionNow();
    return true;
  }

  function deleteSelectedNode() {
    if (!state.selectedNodeId) return;
    deleteNodeById(state.selectedNodeId);
  }

  function saveEdge() {
    const from = elements.edgeFrom.value;
    const to = elements.edgeTo.value;
    let label = elements.edgeLabel.value.trim();
    const selectedEdgeId = elements.edgeSelect.value;
    if (!from || !to) return setStatus("请先选择连线起点和终点。", true);
    if (from === to) return setStatus("连线起点和终点不能相同。", true);
    state.workflow.edges = state.workflow.edges || [];

    const fromNodeForLabel = state.workflow.nodes.find((n) => n.id === from);
    if (!label && (fromNodeForLabel?.type === "branch" || fromNodeForLabel?.type === "parallel")) {
      label = guessLabelForEdge(from);
      elements.edgeLabel.value = label;
    }
    const edgeError = validateEdgeAtEditTime({
      from,
      to,
      label,
      editingEdgeId: selectedEdgeId || null
    });
    if (edgeError) return setStatus(edgeError, true);

    if (selectedEdgeId) {
      const edge = state.workflow.edges.find((e) => e.id === selectedEdgeId);
      if (!edge) return setStatus("未找到要更新的连线。", true);
      recordWorkflowCheckpoint();
      edge.from = from;
      edge.to = to;
      edge.label = label;
      state.selectedEdgeId = edge.id;
      elements.edgeSelect.value = edge.id;
      render();
      persistActiveSessionNow();
      setStatus("连线已更新。");
      return;
    }

    const exists = state.workflow.edges.some((e) => e.from === from && e.to === to && e.label === label);
    if (exists) return setStatus("该连线已存在。", true);
    recordWorkflowCheckpoint();
    state.workflow.edges.push({ id: uid("e"), from, to, label });
    const createdEdge = state.workflow.edges[state.workflow.edges.length - 1];
    state.selectedEdgeId = createdEdge.id;
    elements.edgeSelect.value = createdEdge.id;
    render();
    persistActiveSessionNow();
    if ((fromNodeForLabel?.type === "branch" || fromNodeForLabel?.type === "parallel") && label) {
      setTimeout(() => focusEdgeLabelInput(), 0);
    }
    setStatus("连线已新增。");
  }

  function deleteEdge() {
    const selectedEdgeId = state.selectedEdgeId || elements.edgeSelect.value;
    if (!selectedEdgeId) return setStatus("请先选择要删除的连线。", true);
    const before = (state.workflow.edges || []).length;
    recordWorkflowCheckpoint();
    const kept = (state.workflow.edges || []).filter((e) => e.id !== selectedEdgeId);
    state.workflow.edges = kept;
    if (state.workflow.edges.length === before) return setStatus("未找到要删除的连线。", true);
    state.selectedEdgeId = null;
    elements.edgeSelect.value = "";
    elements.edgeLabel.value = "";
    render();
    persistActiveSessionNow();
    setStatus("连线已删除。");
  }

  function validateEdgeAtEditTime({ from, to, label, editingEdgeId = null }) {
    const nodes = state.workflow.nodes || [];
    const edges = state.workflow.edges || [];

    if (!from || !to) return "请先选择连线起点和终点。";
    if (from === to) return "连线起点和终点不能相同。";
    if (!nodes.some((n) => n.id === from)) return "未找到连线起点节点。";
    if (!nodes.some((n) => n.id === to)) return "未找到连线终点节点。";

    const nextEdges = editingEdgeId
      ? edges.map((e) => (e.id === editingEdgeId ? { ...e, from, to, label } : e))
      : [...edges, { id: "__new__", from, to, label }];
    const cycleBaseEdges = editingEdgeId ? edges.filter((e) => e.id !== editingEdgeId) : edges;
    if (wouldEdgeCreateCycle(cycleBaseEdges, from, to)) {
      return "该连线不允许：会形成有向环（必须保持 DAG）。";
    }

    return "";
  }

  function bindEdgeEvents() {
    elements.edgeFrom?.addEventListener("change", () => {
      renderer.syncEdgeLabelField?.();
    });
    elements.edgeSelect.addEventListener("change", () => {
      const selectedEdgeId = elements.edgeSelect.value;
      state.selectedEdgeId = selectedEdgeId || null;
      const edge = (state.workflow.edges || []).find((e) => e.id === selectedEdgeId);
      if (!edge) {
        elements.edgeLabel.value = "";
        render();
        return;
      }
      elements.edgeFrom.value = edge.from;
      elements.edgeTo.value = edge.to;
      elements.edgeLabel.value = edge.label || "";
      render();
    });
  }

  async function callDeepSeekAndBuildWorkflow() {
    if (!requireGenModeTarget("workflow")) return;

    const prompt = getRevisionNotes();
    const base = elements.apiBase.value.trim().replace(/\/$/, "");
    const mode = getGenMode();
    const meta = getGenModeMeta(mode);

    if (!prompt) return setStatus("请先输入业务描述或修改意见。", true);

    const postOpt = selectPostOptimizeEl?.value || "none";
    if (postOpt === "top4" && !meta.incremental) {
      setStatus("Top-2：将重新生成首图，并须完成「初次修改」→「最终确认」后才能搜索。", false);
    }

    const previousPrompt = String(localStorage.getItem("mwgl_last_user_prompt") || "").trim();
    const effectivePrompt = meta.incremental
      ? buildIncrementalWorkflowPrompt(prompt, state.workflow, previousPrompt)
      : prompt;

    localStorage.setItem("mwgl_api_base", base);
    setStatus(`正在${meta.label}…`);

    try {
      let workflow = await buildWorkflowByDeepSeek({ base, prompt: effectivePrompt });

      const postOpt = selectPostOptimizeEl?.value || "none";
      let optFail = "";
      let optDone = false;
      let optTail = "";
      if (postOpt === "top4") {
        const searchMode = selectTop4SearchModeEl?.value === "mcts" ? "mcts" : "beam";
        localStorage.setItem("mwgl_last_user_prompt", prompt);
        recordWorkflowCheckpoint();
        state.workflow = workflow;
        state.selectedNodeId = state.workflow.nodes[0]?.id || null;
        state.selectedEdgeId = null;
        state.pendingCenterViewport = true;
        render();
        persistActiveSessionNow();
        startHumanReviewAfterGenerate(workflow, prompt, base, searchMode);
        return;
      }

      hideHumanReviewPanel();
      recordWorkflowCheckpoint();
      state.workflow = workflow;
      localStorage.setItem("mwgl_last_user_prompt", prompt);
      state.selectedNodeId = state.workflow.nodes[0]?.id || null;
      state.selectedEdgeId = null;
      state.pendingCenterViewport = true;
      render();
      persistActiveSessionNow();
      const errs = constraintErrors(workflow);
      const tail = optDone ? optTail : "";
      const msg =
        errs.length
          ? `已生成并渲染${tail}（草稿态，最终导出前请修复）：${formatConstraintErrors(errs)}`
          : `已生成 MWGL 并渲染到画布${tail}。`;
      setStatus(optFail ? `${msg}${optFail}` : msg, Boolean(optFail));
    } catch (error) {
      setStatus(`生成失败：${error.message}`, true);
    }
  }

  async function callDeepSeekForPseudocode() {
    if (!requireGenModeTarget("pseudo")) return;

    const base = elements.apiBase.value.trim().replace(/\/$/, "");
    const workflow = state.workflow;
    const meta = getGenModeMeta(getGenMode());

    if (!workflow || !workflow.nodes || !workflow.nodes.length) {
      return setStatus("当前没有可转换的工作流。", true);
    }

    localStorage.setItem("mwgl_api_base", base);
    setStatus(`正在${meta.label}…`);

    try {
      const pseudocode = await dagToPseudocode({
        base,
        workflow,
        mode: meta.incremental ? "incremental" : "regen",
        existingPseudocode: meta.incremental ? elements.pseudocodeText.value : "",
        revisionNotes: getRevisionNotes()
      });
      state.pseudocode = pseudocode;
      elements.pseudocodeText.value = pseudocode;
      syncPseudoHighlight(elements, workflow);
      persistActiveSessionNow();
      setStatus("已生成伪代码。");
    } catch (error) {
      setStatus(`伪代码生成失败：${error.message}`, true);
    }
  }

  async function callDeepSeekForCode() {
    if (!requireGenModeTarget("code")) return;

    const base = elements.apiBase.value.trim().replace(/\/$/, "");
    const pseudocode = elements.pseudocodeText.value.trim();
    const language = elements.codeLanguage.value;
    const meta = getGenModeMeta(getGenMode());

    if (!pseudocode) {
      return setStatus("请先生成或输入伪代码。", true);
    }

    localStorage.setItem("mwgl_api_base", base);
    setStatus(`正在${meta.label}（${language}）…`);

    try {
      const code = await pseudoToCode({
        base,
        pseudocode,
        language,
        workflow: state.workflow,
        mode: meta.incremental ? "incremental" : "regen",
        existingCode: meta.incremental ? elements.codeText.value : "",
        revisionNotes: getRevisionNotes()
      });
      state.code = code;
      elements.codeText.value = code;
      syncCodeHighlight(elements, state.workflow);
      persistActiveSessionNow();
      setStatus(`已生成 ${language} 代码，正在运行检测（失败将自动修复）...`);
      const check = await runCodeCheckWithAutoRepair({ silent: true });
      if (check?.passed) {
        setStatus(`已生成 ${language} 代码，运行检测通过。`);
      } else if (check) {
        setStatus(
          `已生成 ${language} 代码，经自动修复后仍未通过检测（见运行日志，可点「根据报错修复」）。`,
          true
        );
      } else {
        setStatus(`已生成 ${language} 代码，运行检测调用失败。`, true);
      }
    } catch (error) {
      setStatus(`代码生成失败：${error.message}`, true);
    }
  }

  async function runQuickCheck() {
    await runCodeCheckWithAutoRepair();
    document.querySelector('.tab-btn[data-tab="log"]')?.click();
  }

  const loopEditor = createLoopEditor({
    elements,
    state,
    setStatus,
    onChange: () => {
      recordWorkflowCheckpoint();
      render();
      persistActiveSessionNow();
    }
  });

  function bindCanvasEvents() {
    function syncEdgeSelectionToEditor(edgeId) {
      const edge = (state.workflow.edges || []).find((e) => e.id === edgeId);
      if (!edge) return;
      state.selectedEdgeId = edgeId;
      elements.edgeSelect.value = edgeId;
      elements.edgeFrom.value = edge.from;
      elements.edgeTo.value = edge.to;
      elements.edgeLabel.value = edge.label || "";
    }

    function isTypingTarget(target) {
      if (!target) return false;
      const el = target instanceof Element ? target : null;
      if (!el) return false;
      return !!el.closest("input, textarea, select, [contenteditable='true']");
    }

    function getCanvasPoint(event) {
      const rect = elements.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      return screenToUser(px, py, state.canvasOffset || { x: 0, y: 0 }, state.canvasScale);
    }

    function getCanvasWorldPoint(event) {
      const user = getCanvasPoint(event);
      return {
        x: WORLD_WIDTH / 2 + user.x + NODE_LAYOUT_WIDTH / 2,
        y: WORLD_HEIGHT / 2 + user.y + NODE_LAYOUT_HEIGHT / 2
      };
    }

    function getNodeCenterById(id) {
      const node = state.workflow.nodes.find((n) => n.id === id);
      if (!node) return null;
      return {
        x: WORLD_WIDTH / 2 + node.x + NODE_LAYOUT_WIDTH / 2,
        y: WORLD_HEIGHT / 2 + node.y + NODE_LAYOUT_HEIGHT / 2
      };
    }

    function upsertPreviewPath(fromId, x, y) {
      const layer = elements.canvasWorld.querySelector(".edge-layer");
      if (!layer) return;
      const start = getNodeCenterById(fromId);
      if (!start) return;
      let preview = layer.querySelector(".edge-preview");
      if (!preview) {
        preview = document.createElementNS(SVG_NS, "path");
        preview.setAttribute("class", "edge-preview");
        layer.appendChild(preview);
      }
      const midX = Math.round((start.x + x) / 2);
      const d = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${y}, ${x} ${y}`;
      preview.setAttribute("d", d);
    }

    function clearPreviewPath() {
      const layer = elements.canvasWorld.querySelector(".edge-layer");
      const preview = layer ? layer.querySelector(".edge-preview") : null;
      if (preview) preview.remove();
    }

    elements.canvasWorld.addEventListener("pointerdown", (event) => {
      elements.canvas.focus();
      const deleteBtn = event.target.closest(".node-delete");
      if (deleteBtn) {
        const nodeElForDelete = deleteBtn.closest(".node");
        const nodeId = nodeElForDelete?.dataset?.id || "";
        if (deleteNodeById(nodeId)) {
          setStatus("节点已删除。");
        } else {
          setStatus("未找到要删除的节点。", true);
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const edgeEl = event.target.closest(".edge-hit");
      if (edgeEl?.dataset?.edgeId) {
        state.selectedNodeId = null;
        syncEdgeSelectionToEditor(edgeEl.dataset.edgeId);
        render();
        setStatus("已选中连线。按 Delete/Backspace 或点「删除连线」可删除。");
        event.preventDefault();
        return;
      }
      const nodeEl = event.target.closest(".node");
      if (!nodeEl) {
        state.selectedEdgeId = null;
        elements.edgeSelect.value = "";
        state.pendingCenterViewport = false;
        panning = {
          startX: event.clientX,
          startY: event.clientY,
          offsetX: state.canvasOffset?.x || 0,
          offsetY: state.canvasOffset?.y || 0
        };
        event.preventDefault();
        return;
      }
      const id = nodeEl.dataset.id;
      const node = state.workflow.nodes.find((n) => n.id === id);
      if (!node) return;
      const point = getCanvasPoint(event);

      if (event.shiftKey) {
        linking = { fromId: id };
        const wp = getCanvasWorldPoint(event);
        upsertPreviewPath(id, wp.x, wp.y);
        return;
      }

      state.selectedNodeId = id;
      state.selectedEdgeId = null;
      elements.edgeSelect.value = "";
      syncEditor();
      state.drag = {
        id,
        originX: node.x,
        originY: node.y,
        originWorkflow: cloneWorkflowSnapshot(),
        offsetX: point.x - node.x,
        offsetY: point.y - node.y
      };
      nodeEl.classList.add("dragging");
      render();
    });

    window.addEventListener("pointermove", (event) => {
      if (panning) {
        const dx = event.clientX - panning.startX;
        const dy = event.clientY - panning.startY;
        state.canvasOffset = {
          x: panning.offsetX + dx,
          y: panning.offsetY + dy
        };
        applyViewportTransform();
        return;
      }
      if (linking) {
        const wp = getCanvasWorldPoint(event);
        upsertPreviewPath(linking.fromId, wp.x, wp.y);
        return;
      }
      if (!state.drag) return;
      const node = state.workflow.nodes.find((n) => n.id === state.drag.id);
      if (!node) return;
      const point = getCanvasPoint(event);
      node.x = Math.round(point.x - state.drag.offsetX);
      node.y = Math.round(point.y - state.drag.offsetY);
      render();
    });

    window.addEventListener("pointerup", (event) => {
      if (panning) {
        panning = null;
      }
      if (linking) {
        const targetEl = event.target.closest ? event.target.closest(".node") : null;
        if (targetEl) {
          const toId = targetEl.dataset.id;
          const fromId = linking.fromId;
          if (fromId !== toId) {
            const label = guessLabelForEdge(fromId);
            const edgeError = validateEdgeAtEditTime({
              from: fromId,
              to: toId,
              label,
              editingEdgeId: null
            });
            if (edgeError) {
              setStatus(edgeError, true);
              clearPreviewPath();
              linking = null;
              return;
            }
            const exists = (state.workflow.edges || []).some((e) => e.from === fromId && e.to === toId);
            if (!exists) {
              state.workflow.edges = state.workflow.edges || [];
              recordWorkflowCheckpoint();
              const edge = { id: uid("e"), from: fromId, to: toId, label };
              state.workflow.edges.push(edge);
              elements.edgeFrom.value = fromId;
              elements.edgeTo.value = toId;
              elements.edgeLabel.value = label;
              state.selectedEdgeId = edge.id;
              elements.edgeSelect.value = edge.id;
              render();
              persistActiveSessionNow();
              setTimeout(() => focusEdgeLabelInput(), 0);
              setStatus("已通过拖线创建连线。");
            } else {
              setStatus("该连线已存在。", true);
            }
          }
        }
        clearPreviewPath();
        linking = null;
      }

      const dragState = state.drag;
      state.drag = null;
      const dragging = document.querySelector(".node.dragging");
      if (dragging) dragging.classList.remove("dragging");
      if (dragState) {
        const movedNode = state.workflow.nodes.find((n) => n.id === dragState.id);
        const moved = movedNode && (movedNode.x !== dragState.originX || movedNode.y !== dragState.originY);
        if (moved) {
          const cur = getActiveSession();
          if (cur) {
            if (!Array.isArray(cur.undoStack)) cur.undoStack = [];
            cur.undoStack.push(cloneWorkflow(dragState.originWorkflow));
            if (cur.undoStack.length > 80) cur.undoStack = cur.undoStack.slice(-80);
            cur.redoStack = [];
            updateHistoryButtons();
          }
        }
      }
      if (!linking) persistActiveSessionNow();
    });

    elements.canvasWorld.addEventListener("click", (event) => {
      if (event.target.closest(".node-delete")) return;
      const nodeEl = event.target.closest(".node");
      if (!nodeEl) return;
      state.selectedEdgeId = null;
      elements.edgeSelect.value = "";
      state.selectedNodeId = nodeEl.dataset.id;
      render();
      const node = state.workflow.nodes.find((n) => n.id === state.selectedNodeId);
      if (node?.loop) {
        loopEditor.openForNode(node.id);
      }
    });

    window.addEventListener("keydown", (event) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const ctrlOrCmd = isMac ? event.metaKey : event.ctrlKey;
      if (ctrlOrCmd && !isTypingTarget(event.target) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoWorkflowChange();
        else undoWorkflowChange();
        return;
      }
      if (ctrlOrCmd && !isTypingTarget(event.target) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoWorkflowChange();
        return;
      }
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isTypingTarget(event.target)) return;
      if (!state.selectedEdgeId) return;
      event.preventDefault();
      deleteEdge();
    });

    elements.canvas.addEventListener("wheel", (event) => {
      if (!event.ctrlKey) return;
      if (document.activeElement !== elements.canvas) return;
      event.preventDefault();

      const oldScale = state.canvasScale || 1;
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * (event.deltaY < 0 ? 1.08 : 0.92)));
      if (nextScale === oldScale) return;

      state.pendingCenterViewport = false;
      const rect = elements.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const offset = state.canvasOffset || { x: 0, y: 0 };
      const ratio = nextScale / oldScale;

      state.canvasOffset = {
        x: Math.round(px - (px - offset.x) * ratio),
        y: Math.round(py - (py - offset.y) * ratio)
      };
      state.canvasScale = nextScale;
      applyViewportTransform();
    }, { passive: false });
  }

  async function executeCurrentGenMode() {
    const mode = getGenMode();
    const meta = getGenModeMeta(mode);
    if (meta.target === "workflow") {
      await callDeepSeekAndBuildWorkflow();
    } else if (meta.target === "pseudo") {
      await callDeepSeekForPseudocode();
    } else if (meta.target === "code") {
      await callDeepSeekForCode();
    }
  }

  function bindActions() {
    document.getElementById("btnGenerate").addEventListener("click", executeCurrentGenMode);
    btnFinishInitialEditEl?.addEventListener("click", finishInitialEditPhase);
    btnContinueOptimizeEl?.addEventListener("click", continueTop2Optimize);
    btnFinishInitialEditToolbarEl?.addEventListener("click", finishInitialEditPhase);
    btnContinueOptimizeToolbarEl?.addEventListener("click", continueTop2Optimize);
    document.getElementById("btnParseMwgl").addEventListener("click", () => {
      try {
        const workflow = mwglToWorkflow(elements.mwglText.value);
        recordWorkflowCheckpoint();
        state.workflow = workflow;
        state.selectedNodeId = state.workflow.nodes[0]?.id || null;
        state.selectedEdgeId = null;
        state.pendingCenterViewport = true;
        render();
        const errs = constraintErrors(workflow);
        setStatus(
          errs.length
            ? `已导入（草稿态，最终导出前请修复）：${formatConstraintErrors(errs)}`
            : "已从 MWGL 文本导入。"
        );
      } catch (error) {
        setStatus(`MWGL 导入失败：${error.message}`, true);
      }
    });

    document.getElementById("btnExportMwgl").addEventListener("click", async () => {
      const errs = constraintErrors(state.workflow);
      if (errs.length) return setStatus(`当前工作流未通过约束校验：${formatConstraintErrors(errs)}`, true);
      const text = workflowToMwgl(state.workflow);
      elements.mwglText.value = text;
      await navigator.clipboard.writeText(text).catch(() => {});
      setStatus("已导出 MWGL（并尝试复制到剪贴板）。");
    });

    document.getElementById("btnPseudocode").addEventListener("click", callDeepSeekForPseudocode);

    document.getElementById("btnGenCode").addEventListener("click", callDeepSeekForCode);
    document.getElementById("btnRunCode").addEventListener("click", runQuickCheck);
    document.getElementById("btnRepairCode")?.addEventListener("click", repairCodeFromLastFailure);
    if (elements.btnUndoWorkflow) {
      elements.btnUndoWorkflow.addEventListener("click", undoWorkflowChange);
    }
    if (elements.btnRedoWorkflow) {
      elements.btnRedoWorkflow.addEventListener("click", redoWorkflowChange);
    }

    const newSessionBtn = document.getElementById("btnNewSession");
    if (newSessionBtn) {
      newSessionBtn.addEventListener("click", () => {
        saveCurrentSessionSnapshot();
        const next = createSessionPayload(`工作流 ${sessions.length + 1}`);
        sessions.unshift(next);
        activeSessionId = next.id;
        applySession(next);
        persistSessions();
        updateHistoryButtons();
        setStatus(`已新建${next.name}。`);
      });
    }
    if (elements.sessionTitle) {
      elements.sessionTitle.addEventListener("input", () => {
        saveCurrentSessionSnapshot();
        renderSessionList();
        persistSessions();
      });
    }
    if (elements.apiBase) {
      elements.apiBase.addEventListener("change", () => {
        localStorage.setItem("mwgl_api_base", elements.apiBase.value);
        checkApiStatus();
      });
    }

    elements.userPrompt.addEventListener("input", () => {
      saveCurrentSessionSnapshot();
      persistSessions();
    });
    elements.pseudocodeText.addEventListener("input", () => {
      syncPseudoHighlight(elements, state.workflow);
      saveCurrentSessionSnapshot();
      persistSessions();
    });
    elements.codeText.addEventListener("input", () => {
      syncCodeHighlight(elements, state.workflow);
      saveCurrentSessionSnapshot();
      persistSessions();
    });
    bindHighlightScroll(elements);
    elements.codeLanguage.addEventListener("change", () => {
      saveCurrentSessionSnapshot();
      persistSessions();
    });

    document.getElementById("btnExportJson").addEventListener("click", async () => {
      const errs = constraintErrors(state.workflow);
      if (errs.length) return setStatus(`当前工作流未通过约束校验：${formatConstraintErrors(errs)}`, true);
      const text = JSON.stringify(state.workflow, null, 2);
      await navigator.clipboard.writeText(text).catch(() => {});
      setStatus("已导出 JSON（并尝试复制到剪贴板）。");
    });

    document.getElementById("addEvent").addEventListener("click", () => addNode("start"));
    document.getElementById("addStep").addEventListener("click", () => addNode("step"));
    document.getElementById("addForLoop")?.addEventListener("click", () => addForLoopNode());
    document.getElementById("addBranch").addEventListener("click", () => addNode("branch"));
    document.getElementById("addParallel")?.addEventListener("click", () => addNode("parallel"));
    document.getElementById("addEndSuccess").addEventListener("click", () => addNode("end_success"));
    document.getElementById("addEndFailure").addEventListener("click", () => addNode("end_failure"));
    elements.nodeType?.addEventListener("change", () => {
      const ty = elements.nodeType.value;
      if (elements.endOutcomeRow) {
        elements.endOutcomeRow.classList.toggle("hidden", ty !== "end");
      }
      const node = getSelectedNode();
      if (node) {
        const draft = { ...node, type: ty };
        renderer.syncForkNodeHints?.(draft);
        renderer.syncNodeTextPlaceholder?.(draft);
      }
    });
    document.getElementById("btnLayoutLr").addEventListener("click", () => {
      recordWorkflowCheckpoint();
      layoutWorkflowLeftToRight(state.workflow);
      state.pendingCenterViewport = true;
      render();
      setStatus("已按执行顺序从左到右排列。");
    });

    document.getElementById("saveNode").addEventListener("click", () => {
      saveEditorToNode();
      setStatus("节点已更新。");
    });

    document.getElementById("deleteNode").addEventListener("click", () => {
      deleteSelectedNode();
      setStatus("节点已删除。");
    });

    document.getElementById("saveEdge").addEventListener("click", saveEdge);
    document.getElementById("deleteEdge").addEventListener("click", deleteEdge);
  }

  bootstrapSessions();
  updateHistoryButtons();
  bindActions();
  bindCanvasEvents();
  bindEdgeEvents();
  initTabs();
  checkApiStatus();
  setInterval(() => {
    saveCurrentSessionSnapshot();
    persistSessions();
  }, 3000);
}
