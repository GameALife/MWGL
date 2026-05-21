import { bindInteractions } from "./interactions.js";
import { layoutWorkflowLeftToRight } from "./mwgl.js";
import { createRenderer } from "./renderer.js";
import { state } from "./state.js";

const elements = {
  apiBase: document.getElementById("apiBase"),
  sessionTitle: document.getElementById("sessionTitle"),
  sessionList: document.getElementById("sessionList"),
  btnUndoWorkflow: document.getElementById("btnUndoWorkflow"),
  btnRedoWorkflow: document.getElementById("btnRedoWorkflow"),
  historyHint: document.getElementById("historyHint"),
  userPrompt: document.getElementById("userPrompt"),
  status: document.getElementById("status"),
  canvas: document.getElementById("canvas"),
  canvasViewport: document.getElementById("canvasViewport"),
  canvasWorld: document.getElementById("canvasWorld"),
  jsonView: document.getElementById("jsonView"),
  mwglText: document.getElementById("mwglText"),
  nodeType: document.getElementById("nodeType"),
  nodeOutcome: document.getElementById("nodeOutcome"),
  endOutcomeRow: document.getElementById("endOutcomeRow"),
  nodeText: document.getElementById("nodeText"),
  nodeX: document.getElementById("nodeX"),
  nodeY: document.getElementById("nodeY"),
  edgeFrom: document.getElementById("edgeFrom"),
  edgeTo: document.getElementById("edgeTo"),
  edgeLabel: document.getElementById("edgeLabel"),
  edgeSelect: document.getElementById("edgeSelect"),
  pseudocodeText: document.getElementById("pseudocodeText"),
  pseudocodeHighlight: document.getElementById("pseudocodeHighlight"),
  pseudoLegend: document.getElementById("pseudoLegend"),
  codeText: document.getElementById("codeText"),
  codeHighlight: document.getElementById("codeHighlight"),
  codeLegend: document.getElementById("codeLegend"),
  codeCheckBadge: document.getElementById("codeCheckBadge"),
  runResultText: document.getElementById("runResultText"),
  runCheckSummary: document.getElementById("runCheckSummary"),
  codeLanguage: document.getElementById("codeLanguage"),
  constraintPanel: document.getElementById("constraintPanel"),
  constraintList: document.getElementById("constraintList"),
  loopPanel: document.getElementById("loopPanel"),
  loopPanelTitle: document.getElementById("loopPanelTitle"),
  loopPanelBreadcrumb: document.getElementById("loopPanelBreadcrumb"),
  loopPanelClose: document.getElementById("loopPanelClose"),
  loopKind: document.getElementById("loopKind"),
  loopCondition: document.getElementById("loopCondition"),
  loopSaveMeta: document.getElementById("loopSaveMeta"),
  loopLoopStepList: document.getElementById("loopLoopStepList"),
  loopAddStep: document.getElementById("loopAddStep"),
  loopAddFor: document.getElementById("loopAddFor"),
  loopAddSubflow: document.getElementById("loopAddSubflow")
};

function bootstrap() {
  const renderer = createRenderer(elements);
  const savedBase = localStorage.getItem("mwgl_api_base");
  if (savedBase) elements.apiBase.value = savedBase;

  bindInteractions(elements, renderer);
  layoutWorkflowLeftToRight(state.workflow);
  state.pendingCenterViewport = true;
  renderer.render();
  renderer.setStatus("就绪：可输入需求后直接生成。");
}

bootstrap();
