import { useRef, useState } from "react";
import { Image, PanResponder, StyleSheet, Text, View } from "react-native";

import { colors, radius } from "../theme";
import { getContainedImageLayout, getMinimumAnnotationBoxSize, projectBoundingBox, resizeBoundingBox, screenPointToImage, translateBoundingBox } from "../utils/imageCoordinates";
import type { BoxCorner, ImageBoundingBox } from "../utils/imageCoordinates";

type Props = { imageUri: string; imageWidth: number; imageHeight: number; box: ImageBoundingBox | null; label?: string; onBoxChange: (box: ImageBoundingBox | null) => void };
type Snapshot = { box: ImageBoundingBox | null; scale: number };
type Responder = ReturnType<typeof PanResponder.create>;
type EditorResponders = { draw: Responder; move: Responder; handles: Record<BoxCorner, Responder> };

export function BoundingBoxEditor({ imageUri, imageWidth, imageHeight, box, label, onBoxChange }: Props) {
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  const [imageStatus, setImageStatus] = useState("WAITING");
  const [activeControl, setActiveControl] = useState<BoxCorner | "move" | "draw" | null>(null);
  const latest = useRef({ box, imageWidth, imageHeight, viewSize, onBoxChange });
  const snapshot = useRef<Snapshot>({ box: null, scale: 1 });
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const drawHasMoved = useRef(false);
  const responders = useRef<EditorResponders | null>(null);
  latest.current = { box, imageWidth, imageHeight, viewSize, onBoxChange };

  function captureSnapshot() {
    const current = latest.current;
    const layout = getContainedImageLayout(current.imageWidth, current.imageHeight, current.viewSize.width, current.viewSize.height);
    snapshot.current = { box: current.box ? { ...current.box } : null, scale: layout?.scale || 1 };
  }

  function createMoveResponder() {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { captureSnapshot(); setActiveControl("move"); },
      onPanResponderMove: (_event, gestureState) => {
        const current = latest.current;
        const start = snapshot.current;
        if (!start.box || start.scale <= 0) return;
        current.onBoxChange(translateBoundingBox(start.box, gestureState.dx / start.scale, gestureState.dy / start.scale, current.imageWidth, current.imageHeight));
      },
      onPanResponderRelease: () => setActiveControl(null),
      onPanResponderTerminate: () => setActiveControl(null),
    });
  }

  function createResizeResponder(corner: BoxCorner) {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { captureSnapshot(); setActiveControl(corner); },
      onPanResponderMove: (_event, gestureState) => {
        const current = latest.current;
        const start = snapshot.current;
        if (!start.box || start.scale <= 0) return;
        current.onBoxChange(resizeBoundingBox(start.box, corner, gestureState.dx / start.scale, gestureState.dy / start.scale, current.imageWidth, current.imageHeight, getMinimumAnnotationBoxSize(current.imageWidth, current.imageHeight)));
      },
      onPanResponderRelease: () => setActiveControl(null),
      onPanResponderTerminate: () => setActiveControl(null),
    });
  }

  function createDrawResponder() {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => latest.current.box == null,
      onMoveShouldSetPanResponder: () => latest.current.box == null,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        const current = latest.current;
        if (current.box) { drawStart.current = null; return; }
        const layout = getContainedImageLayout(current.imageWidth, current.imageHeight, current.viewSize.width, current.viewSize.height);
        drawStart.current = screenPointToImage(event.nativeEvent.locationX, event.nativeEvent.locationY, current.imageWidth, current.imageHeight, current.viewSize.width, current.viewSize.height);
        drawHasMoved.current = false;
        snapshot.current = { box: null, scale: layout?.scale || 1 };
        if (drawStart.current) {
          const defaultWidth = current.imageWidth * 0.5;
          const defaultHeight = current.imageHeight * 0.5;
          const x1 = Math.max(0, Math.min(current.imageWidth - defaultWidth, drawStart.current.x - defaultWidth / 2));
          const y1 = Math.max(0, Math.min(current.imageHeight - defaultHeight, drawStart.current.y - defaultHeight / 2));
          current.onBoxChange({ x1, y1, x2: x1 + defaultWidth, y2: y1 + defaultHeight });
          setActiveControl("draw");
        }
      },
      onPanResponderMove: (_event, gestureState) => {
        const current = latest.current;
        const start = drawStart.current;
        const scale = snapshot.current.scale;
        if (!start || scale <= 0) return;
        if (!drawHasMoved.current && Math.hypot(gestureState.dx, gestureState.dy) < 6) return;
        drawHasMoved.current = true;
        const end = { x: Math.max(0, Math.min(current.imageWidth, start.x + gestureState.dx / scale)), y: Math.max(0, Math.min(current.imageHeight, start.y + gestureState.dy / scale)) };
        current.onBoxChange({ x1: Math.min(start.x, end.x), y1: Math.min(start.y, end.y), x2: Math.max(start.x, end.x), y2: Math.max(start.y, end.y) });
      },
      onPanResponderRelease: () => { drawStart.current = null; drawHasMoved.current = false; setActiveControl(null); },
      onPanResponderTerminate: () => { drawStart.current = null; drawHasMoved.current = false; setActiveControl(null); },
    });
  }

  if (!responders.current) {
    responders.current = {
      draw: createDrawResponder(),
      move: createMoveResponder(),
      handles: {
        topLeft: createResizeResponder("topLeft"), topRight: createResizeResponder("topRight"),
        bottomLeft: createResizeResponder("bottomLeft"), bottomRight: createResizeResponder("bottomRight"),
      },
    };
  }

  const projected = box ? projectBoundingBox(box, imageWidth, imageHeight, viewSize.width, viewSize.height) : null;
  const editorResponders = responders.current;
  const handle = (corner: BoxCorner, left: number, top: number) => (
    <View collapsable={false} {...editorResponders.handles[corner].panHandlers} style={[styles.handle, { left, top }]}><View pointerEvents="none" style={[styles.handleDot, activeControl === corner && styles.activeHandleDot]} /></View>
  );

  const editor = (
      <View collapsable={false} {...(!box ? editorResponders.draw.panHandlers : {})} style={styles.container} onLayout={(event) => setViewSize(event.nativeEvent.layout)}>
        <Image
          source={{ uri: imageUri }}
          style={[StyleSheet.absoluteFillObject, styles.image]}
          resizeMode="contain"
          onLoadStart={() => setImageStatus("LOADING")}
          onLoad={() => setImageStatus("LOADED")}
          onError={(event) => setImageStatus(`ERROR: ${event.nativeEvent.error || "unknown image error"}`)}
        />
        <View pointerEvents="none" style={styles.debugBadge}>
          <Text style={styles.debugText}>{imageStatus}</Text>
        </View>
        {!box ? <View pointerEvents="none" style={styles.drawPrompt}><Text style={styles.drawPromptText}>Tap or drag on the product to create a box</Text></View> : null}
        <View pointerEvents="box-none" style={styles.overlayLayer}>
          {projected ? <View collapsable={false} style={[styles.box, projected, activeControl && styles.activeBox]}>
              <View collapsable={false} {...editorResponders.move.panHandlers} style={StyleSheet.absoluteFillObject} />
              {label ? <View pointerEvents="none" style={styles.label}><Text numberOfLines={1} style={styles.labelText}>{label}</Text></View> : null}
            </View> : null}
          {projected ? <>
            {handle("topLeft", projected.left - HANDLE_TOUCH_SIZE / 2, projected.top - HANDLE_TOUCH_SIZE / 2)}
            {handle("topRight", projected.left + projected.width - HANDLE_TOUCH_SIZE / 2, projected.top - HANDLE_TOUCH_SIZE / 2)}
            {handle("bottomLeft", projected.left - HANDLE_TOUCH_SIZE / 2, projected.top + projected.height - HANDLE_TOUCH_SIZE / 2)}
            {handle("bottomRight", projected.left + projected.width - HANDLE_TOUCH_SIZE / 2, projected.top + projected.height - HANDLE_TOUCH_SIZE / 2)}
          </> : null}
        </View>
      </View>
  );

  return editor;
}

const HANDLE_TOUCH_SIZE = 48;
const styles = StyleSheet.create({
  container: { position: "relative", width: "100%", height: 430, overflow: "hidden", backgroundColor: colors.surfaceMuted, borderRadius: radius.lg },
  image: { zIndex: 0 },
  overlayLayer: { ...StyleSheet.absoluteFillObject, zIndex: 10 },
  box: { position: "absolute", zIndex: 11, borderWidth: 4, borderColor: "#f59e0b", backgroundColor: "rgba(245, 158, 11, 0.10)" },
  activeBox: { borderColor: "#fbbf24", borderWidth: 5, backgroundColor: "rgba(245, 158, 11, 0.18)" },
  label: { position: "absolute", zIndex: 14, left: -4, top: -29, maxWidth: 180, backgroundColor: "#f59e0b", paddingHorizontal: 8, paddingVertical: 5, borderRadius: 5 },
  labelText: { color: colors.primaryText, fontSize: 12, fontWeight: "800" },
  drawPrompt: { position: "absolute", zIndex: 20, alignSelf: "center", top: 16, backgroundColor: "rgba(15, 23, 42, 0.82)", borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7 },
  drawPromptText: { color: colors.primaryText, fontSize: 13, fontWeight: "700" },
  handle: { position: "absolute", zIndex: 15, width: HANDLE_TOUCH_SIZE, height: HANDLE_TOUCH_SIZE, borderRadius: HANDLE_TOUCH_SIZE / 2, alignItems: "center", justifyContent: "center" },
  handleDot: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.surface, borderWidth: 4, borderColor: "#f59e0b" },
  activeHandleDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.amber, borderColor: colors.surface },
  debugBadge: {
    position: "absolute",
    left: 10,
    bottom: 10,
    zIndex: 100,
    maxWidth: "95%",
    backgroundColor: "rgba(0, 0, 0, 0.82)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  debugText: { color: "#ffffff", fontSize: 12, fontWeight: "800" },
});
