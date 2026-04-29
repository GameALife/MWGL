import { bindInteractions } from "./interactions.js";
import { layoutWorkflowLeftToRight } from "./mwgl.js";
import { createRenderer } from "./renderer.js";
import { state } from "./state.js";

const elements = {
  apiBase: document.getElementById("apiBase"),
  sessionSelect: document.getElementById("sessionSelect"),
  btnUndoWorkflow: document.getElementById("btnUndoWorkflow"),
  btnRedoWorkflow: document.getElementById("btnRedoWorkflow"),
  historyHint: document.getElementById("historyHint"),
  btnNewSession: document.getElementById("btnNewSession"),
  btnDeleteSession: document.getElementById("btnDeleteSession"),
  userPrompt: document.getElementById("userPrompt"),
  status: document.getElementById("status"),
  canvas: document.getElementById("canvas"),
  canvasViewport: document.getElementById("canvasViewport"),
  canvasWorld: document.getElementById("canvasWorld"),
  jsonView: document.getElementById("jsonView"),
  mwglText: document.getElementById("mwglText"),
  nodeType: document.getElementById("nodeType"),
  nodeText: document.getElementById("nodeText"),
  nodeX: document.getElementById("nodeX"),
  nodeY: document.getElementById("nodeY"),
  edgeFrom: document.getElementById("edgeFrom"),
  edgeTo: document.getElementById("edgeTo"),
  edgeLabel: document.getElementById("edgeLabel"),
  edgeSelect: document.getElementById("edgeSelect"),
  pseudocodeText: document.getElementById("pseudocodeText"),
  codeText: document.getElementById("codeText"),
  runResultText: document.getElementById("runResultText"),
  codeLanguage: document.getElementById("codeLanguage"),
  constraintPanel: document.getElementById("constraintPanel"),
  constraintList: document.getElementById("constraintList")
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
