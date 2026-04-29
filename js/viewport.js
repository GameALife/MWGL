/**
 * 节点 JSON 中的 node.x / node.y：**以画布（世界）中心为原点 (0,0)**，右为正 x，下为正 y。
 * 世界像素坐标 = (WORLD_WIDTH/2 + x, WORLD_HEIGHT/2 + y)。
 * 屏幕：screen = offset + worldPixel * scale
 */

export const NODE_LAYOUT_WIDTH = 200;
export const NODE_LAYOUT_HEIGHT = 56;

export const WORLD_WIDTH = 7000;
export const WORLD_HEIGHT = 5000;

export function workflowBBox(nodes, nodeW = NODE_LAYOUT_WIDTH, nodeH = NODE_LAYOUT_HEIGHT) {
  if (!nodes?.length) return null;
  return {
    minX: Math.min(...nodes.map((n) => n.x)),
    minY: Math.min(...nodes.map((n) => n.y)),
    maxX: Math.max(...nodes.map((n) => n.x + nodeW)),
    maxY: Math.max(...nodes.map((n) => n.y + nodeH))
  };
}

export function bboxCenter(bbox) {
  return {
    x: (bbox.minX + bbox.maxX) / 2,
    y: (bbox.minY + bbox.maxY) / 2
  };
}

/** bbox 为「以画布中心为原点」的节点坐标；返回使该 bbox 中心对齐视口中心的 offset（世界层 transform-origin 0 0） */
export function offsetToCenterBBox(
  bbox,
  vpW,
  vpH,
  scale,
  worldW = WORLD_WIDTH,
  worldH = WORLD_HEIGHT
) {
  if (!bbox || vpW <= 0 || vpH <= 0) return null;
  const c = bboxCenter(bbox);
  const s = Number.isFinite(scale) ? scale : 1;
  const cxW = worldW / 2 + c.x;
  const cyW = worldH / 2 + c.y;
  return {
    x: Math.round(vpW / 2 - cxW * s),
    y: Math.round(vpH / 2 - cyW * s)
  };
}

/** 视口内像素 → 世界层像素（左上角为 0 的大画布） */
export function screenToWorldPixel(screenX, screenY, offset, scale) {
  const s = Number.isFinite(scale) ? scale : 1;
  return {
    x: (screenX - offset.x) / s,
    y: (screenY - offset.y) / s
  };
}

/** 视口内像素 → 以画布中心为原点的用户坐标（与 node.x / node.y 一致） */
export function screenToUser(screenX, screenY, offset, scale) {
  const p = screenToWorldPixel(screenX, screenY, offset, scale);
  return {
    x: p.x - WORLD_WIDTH / 2,
    y: p.y - WORLD_HEIGHT / 2
  };
}

export function formatWorldTransform(offset, scale) {
  const ox = offset?.x ?? 0;
  const oy = offset?.y ?? 0;
  const s = Number.isFinite(scale) ? scale : 1;
  return `translate(${ox}px, ${oy}px) scale(${s})`;
}

/** 平移所有节点，使当前包围盒中心落在用户坐标 (0,0)（画布中心） */
export function alignWorkflowBBoxToOrigin(workflow) {
  const nodes = workflow?.nodes;
  if (!nodes?.length) return;
  const bbox = workflowBBox(nodes);
  if (!bbox) return;
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  for (const n of nodes) {
    n.x = Math.round(n.x - cx);
    n.y = Math.round(n.y - cy);
  }
}
