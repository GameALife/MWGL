import { NODE_TYPES } from "./mwgl.js";

export { NODE_TYPES };
export { uid } from "./ids.js";

export const state = {
  workflow: {
    mwgl_version: 3,
    rule_id: "R_BLANK",
    rule_name: "空白工作流",
    nodes: [],
    edges: []
  },
  selectedNodeId: null,
  selectedEdgeId: null,
  drag: null,
  canvasOffset: { x: 0, y: 0 },
  canvasScale: 1,
  pendingCenterViewport: true,
  pseudocode: "",
  code: ""
};
