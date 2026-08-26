export type ImageBoundingBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type ContainedImageLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
};

export type ProjectedBoundingBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type BoxCorner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

export function areImageDimensionsCompatible(
  canonicalWidth: number,
  canonicalHeight: number,
  decodedWidth: number,
  decodedHeight: number,
  tolerance = 0.01,
) {
  if (
    ![canonicalWidth, canonicalHeight, decodedWidth, decodedHeight, tolerance].every(Number.isFinite)
    || canonicalWidth <= 0
    || canonicalHeight <= 0
    || decodedWidth <= 0
    || decodedHeight <= 0
    || tolerance < 0
  ) {
    return false;
  }

  const scaleX = decodedWidth / canonicalWidth;
  const scaleY = decodedHeight / canonicalHeight;
  const relativeScaleDifference = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);

  return relativeScaleDifference <= tolerance;
}

export function getMinimumAnnotationBoxSize(imageWidth: number, imageHeight: number) {
  return Math.max(8, Math.min(imageWidth, imageHeight) * 0.02);
}

export function getContainedImageLayout(
  imageWidth: number,
  imageHeight: number,
  viewWidth: number,
  viewHeight: number,
): ContainedImageLayout | null {
  if (![imageWidth, imageHeight, viewWidth, viewHeight].every(Number.isFinite)) return null;
  if (imageWidth <= 0 || imageHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) return null;

  const scale = Math.min(viewWidth / imageWidth, viewHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    left: (viewWidth - width) / 2,
    top: (viewHeight - height) / 2,
    width,
    height,
    scale,
  };
}

export function projectBoundingBox(
  box: ImageBoundingBox,
  imageWidth: number,
  imageHeight: number,
  viewWidth: number,
  viewHeight: number,
): ProjectedBoundingBox | null {
  const layout = getContainedImageLayout(imageWidth, imageHeight, viewWidth, viewHeight);
  if (!layout || ![box.x1, box.y1, box.x2, box.y2].every(Number.isFinite)) return null;

  const x1 = Math.max(0, Math.min(imageWidth, box.x1));
  const y1 = Math.max(0, Math.min(imageHeight, box.y1));
  const x2 = Math.max(0, Math.min(imageWidth, box.x2));
  const y2 = Math.max(0, Math.min(imageHeight, box.y2));
  if (x2 <= x1 || y2 <= y1) return null;

  return {
    left: layout.left + x1 * layout.scale,
    top: layout.top + y1 * layout.scale,
    width: (x2 - x1) * layout.scale,
    height: (y2 - y1) * layout.scale,
  };
}

export function unprojectBoundingBox(
  box: ProjectedBoundingBox,
  imageWidth: number,
  imageHeight: number,
  viewWidth: number,
  viewHeight: number,
): ImageBoundingBox | null {
  const layout = getContainedImageLayout(imageWidth, imageHeight, viewWidth, viewHeight);
  if (!layout || ![box.left, box.top, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return null;
  return clampImageBoundingBox({
    x1: (box.left - layout.left) / layout.scale,
    y1: (box.top - layout.top) / layout.scale,
    x2: (box.left + box.width - layout.left) / layout.scale,
    y2: (box.top + box.height - layout.top) / layout.scale,
  }, imageWidth, imageHeight);
}

export function screenPointToImage(
  x: number,
  y: number,
  imageWidth: number,
  imageHeight: number,
  viewWidth: number,
  viewHeight: number,
): { x: number; y: number } | null {
  const layout = getContainedImageLayout(imageWidth, imageHeight, viewWidth, viewHeight);
  if (!layout || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < layout.left || y < layout.top || x > layout.left + layout.width || y > layout.top + layout.height) return null;
  return {
    x: Math.max(0, Math.min(imageWidth, (x - layout.left) / layout.scale)),
    y: Math.max(0, Math.min(imageHeight, (y - layout.top) / layout.scale)),
  };
}

export function clampImageBoundingBox(
  box: ImageBoundingBox,
  imageWidth: number,
  imageHeight: number,
  minSize = 1,
): ImageBoundingBox | null {
  if (![box.x1, box.y1, box.x2, box.y2, imageWidth, imageHeight, minSize].every(Number.isFinite)) return null;
  if (imageWidth <= 0 || imageHeight <= 0 || minSize <= 0 || minSize > imageWidth || minSize > imageHeight) return null;
  const x1 = Math.max(0, Math.min(imageWidth - minSize, box.x1));
  const y1 = Math.max(0, Math.min(imageHeight - minSize, box.y1));
  const x2 = Math.max(x1 + minSize, Math.min(imageWidth, box.x2));
  const y2 = Math.max(y1 + minSize, Math.min(imageHeight, box.y2));
  return { x1, y1, x2, y2 };
}

export function translateBoundingBox(
  box: ImageBoundingBox,
  deltaX: number,
  deltaY: number,
  imageWidth: number,
  imageHeight: number,
): ImageBoundingBox {
  const width = box.x2 - box.x1;
  const height = box.y2 - box.y1;
  const x1 = Math.max(0, Math.min(imageWidth - width, box.x1 + deltaX));
  const y1 = Math.max(0, Math.min(imageHeight - height, box.y1 + deltaY));
  return { x1, y1, x2: x1 + width, y2: y1 + height };
}

export function resizeBoundingBox(
  box: ImageBoundingBox,
  corner: BoxCorner,
  deltaX: number,
  deltaY: number,
  imageWidth: number,
  imageHeight: number,
  minSize = 4,
): ImageBoundingBox {
  let { x1, y1, x2, y2 } = box;
  if (corner === "topLeft" || corner === "bottomLeft") x1 = Math.max(0, Math.min(x2 - minSize, x1 + deltaX));
  else x2 = Math.min(imageWidth, Math.max(x1 + minSize, x2 + deltaX));
  if (corner === "topLeft" || corner === "topRight") y1 = Math.max(0, Math.min(y2 - minSize, y1 + deltaY));
  else y2 = Math.min(imageHeight, Math.max(y1 + minSize, y2 + deltaY));
  return { x1, y1, x2, y2 };
}
