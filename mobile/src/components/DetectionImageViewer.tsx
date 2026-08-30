import { useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import type { DetectionItem } from "../types/api";
import { colors, radius } from "../theme";
import { projectBoundingBox } from "../utils/imageCoordinates";
import { useAuthenticatedImage } from "./useAuthenticatedImage";

type DetectionImageViewerProps = {
  imageUri: string;
  imageWidth: number;
  imageHeight: number;
  detections: DetectionItem[];
  highlightedDetectionId?: number | null;
  showLabels?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function DetectionImageViewer({
  imageUri,
  imageWidth,
  imageHeight,
  detections,
  highlightedDetectionId = null,
  showLabels = true,
  style,
}: DetectionImageViewerProps) {
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  const image = useAuthenticatedImage(imageUri);
  const imageUnavailable = image.status === "ERROR";

  return (
    <View
      style={[styles.container, style]}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setViewSize((current) => current.width === width && current.height === height ? current : { width, height });
      }}
    >
      {image.resolvedUri ? <Image
        source={{ uri: image.resolvedUri }}
        style={StyleSheet.absoluteFillObject}
        resizeMode="contain"
        onLoad={image.onLoad}
        onError={image.onError}
      /> : null}
      {imageUnavailable ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Retry image" style={styles.imageFallback} onPress={image.retry}>
          <Text style={styles.imageFallbackText}>Image unavailable</Text>
          <Text style={styles.imageRetryText}>Tap to retry</Text>
        </Pressable>
      ) : null}
      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        {!imageUnavailable ? detections.map((detection) => {
          if (detection.x1 == null || detection.y1 == null || detection.x2 == null || detection.y2 == null) return null;
          const projected = projectBoundingBox(
            { x1: detection.x1, y1: detection.y1, x2: detection.x2, y2: detection.y2 },
            imageWidth,
            imageHeight,
            viewSize.width,
            viewSize.height,
          );
          if (!projected) return null;
          const highlighted = detection.id === highlightedDetectionId;
          return (
            <View
              key={detection.id}
              style={[
                styles.box,
                projected,
                highlighted ? styles.highlightedBox : styles.standardBox,
              ]}
            >
              {showLabels ? (
                <View style={[styles.label, highlighted && styles.highlightedLabel]}>
                  <Text numberOfLines={1} style={styles.labelText}>
                    {detection.label} · {Math.round(detection.confidence * 100)}%
                  </Text>
                </View>
              ) : null}
            </View>
          );
        }) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { overflow: "hidden", backgroundColor: colors.surfaceMuted, borderRadius: radius.lg },
  box: { position: "absolute", borderWidth: 2 },
  standardBox: { borderColor: colors.primary },
  highlightedBox: { borderColor: colors.amber, borderWidth: 3 },
  label: { position: "absolute", top: 0, left: 0, maxWidth: "100%", backgroundColor: colors.primary, paddingHorizontal: 5, paddingVertical: 2 },
  highlightedLabel: { backgroundColor: colors.amber },
  labelText: { color: colors.primaryText, fontSize: 12, fontWeight: "800" },
  imageFallback: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", padding: 16 },
  imageFallbackText: { color: colors.textMuted, fontSize: 13, fontWeight: "700" },
  imageRetryText: { color: colors.primary, fontSize: 12, fontWeight: "700", marginTop: 4 },
});
