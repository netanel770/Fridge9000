import {
  areImageDimensionsCompatible,
  clampImageBoundingBox,
  getContainedImageLayout,
  getMinimumAnnotationBoxSize,
  projectBoundingBox,
  resizeBoundingBox,
  screenPointToImage,
  translateBoundingBox,
  unprojectBoundingBox,
} from "../../src/utils/imageCoordinates";

describe("image coordinate utilities", () => {
  test.each([
    [1000, 500, 500, 250, true],
    [1000, 500, 1000, 505, true],
    [1000, 500, 900, 500, false],
    [0, 500, 500, 250, false],
    [1000, 500, Number.NaN, 250, false],
  ])("checks dimension compatibility", (cw, ch, dw, dh, expected) => {
    expect(areImageDimensionsCompatible(cw, ch, dw, dh)).toBe(expected);
  });

  test("computes aspect-fit scale and both horizontal and vertical offsets", () => {
    expect(getContainedImageLayout(400, 200, 300, 300)).toEqual({
      left: 0, top: 75, width: 300, height: 150, scale: 0.75,
    });
    expect(getContainedImageLayout(200, 400, 300, 300)).toEqual({
      left: 75, top: 0, width: 150, height: 300, scale: 0.75,
    });
    expect(getContainedImageLayout(0, 200, 300, 300)).toBeNull();
  });

  test("projects source coordinates with aspect-fit offset and clamps image edges", () => {
    expect(projectBoundingBox({ x1: -10, y1: 20, x2: 500, y2: 180 }, 400, 200, 300, 300)).toEqual({
      left: 0, top: 90, width: 300, height: 120,
    });
    expect(projectBoundingBox({ x1: 20, y1: 20, x2: 10, y2: 30 }, 400, 200, 300, 300)).toBeNull();
  });

  test("round-trips a bounding box within floating-point tolerance", () => {
    const source = { x1: 12.5, y1: 20.25, x2: 321.75, y2: 180.5 };
    const projected = projectBoundingBox(source, 400, 250, 720, 500);
    expect(projected).not.toBeNull();
    const restored = unprojectBoundingBox(projected!, 400, 250, 720, 500);
    expect(restored).not.toBeNull();
    Object.keys(source).forEach((key) => {
      expect(restored![key as keyof typeof source]).toBeCloseTo(source[key as keyof typeof source], 8);
    });
  });

  test("maps only points inside the contained image", () => {
    expect(screenPointToImage(150, 150, 400, 200, 300, 300)).toEqual({ x: 200, y: 100 });
    expect(screenPointToImage(150, 40, 400, 200, 300, 300)).toBeNull();
    expect(screenPointToImage(Number.NaN, 100, 400, 200, 300, 300)).toBeNull();
  });

  test("clamps boxes and enforces minimum size at image edges", () => {
    expect(clampImageBoundingBox({ x1: -4, y1: 99, x2: 2, y2: 101 }, 100, 100, 8)).toEqual({
      x1: 0, y1: 92, x2: 8, y2: 100,
    });
    expect(clampImageBoundingBox({ x1: 1, y1: 1, x2: 2, y2: 2 }, 5, 5, 8)).toBeNull();
    expect(clampImageBoundingBox({ x1: 1, y1: 1, x2: Number.NaN, y2: 2 }, 100, 100)).toBeNull();
  });

  test("translates and resizes without crossing source boundaries", () => {
    const box = { x1: 10, y1: 10, x2: 50, y2: 40 };
    expect(translateBoundingBox(box, 100, -100, 120, 100)).toEqual({ x1: 80, y1: 0, x2: 120, y2: 30 });
    expect(resizeBoundingBox(box, "topLeft", 100, 100, 120, 100, 8)).toEqual({ x1: 42, y1: 32, x2: 50, y2: 40 });
    expect(resizeBoundingBox(box, "bottomRight", 100, 100, 120, 100, 8)).toEqual({ x1: 10, y1: 10, x2: 120, y2: 100 });
  });

  test("uses a stable minimum annotation size", () => {
    expect(getMinimumAnnotationBoxSize(100, 200)).toBe(8);
    expect(getMinimumAnnotationBoxSize(1000, 500)).toBe(10);
  });
});
