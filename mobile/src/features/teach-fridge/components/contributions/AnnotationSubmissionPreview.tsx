import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { DetectionImageViewer } from "../../../../components/DetectionImageViewer";
import { getAnnotationSubmissionImageUrl } from "../../../../services/api";
import type { AnnotationSubmissionDetail } from "../../../../types/api";
import { colors } from "../../../../theme";
import { actionTitle, annotationDetection, contributionProductLabel, hasDrawableBox } from "../../annotationUtils";
import { styles } from "../../styles";

export function AnnotationSubmissionPreview({ detail, focusedAnnotationId, onFocusAnnotation }: {
  detail: AnnotationSubmissionDetail;
  focusedAnnotationId: number | null;
  onFocusAnnotation: (annotationId: number) => void;
}) {
  const dimensionsValid = detail.submission.image_width > 0 && detail.submission.image_height > 0;
  const imageWidth = dimensionsValid ? detail.submission.image_width : 1;
  const imageHeight = dimensionsValid ? detail.submission.image_height : 1;
  const annotationDetections = detail.annotations.map(annotationDetection);
  const drawableDetections = dimensionsValid ? annotationDetections.filter((detection) => hasDrawableBox(detection, imageWidth, imageHeight)) : [];
  const drawableIds = new Set(drawableDetections.map((detection) => detection.id));
  const missingBoxCount = annotationDetections.length - drawableDetections.length;

  return <View style={styles.annotationSubmissionPreview}>
    <DetectionImageViewer imageUri={getAnnotationSubmissionImageUrl(detail.submission.id)} imageWidth={imageWidth} imageHeight={imageHeight} detections={drawableDetections} highlightedDetectionId={focusedAnnotationId} showLabels={false} style={[styles.quarantineImage, { aspectRatio: imageWidth / imageHeight }]} />
    {missingBoxCount ? <Text style={styles.quarantineBoxNotice}>{missingBoxCount} annotation{missingBoxCount === 1 ? " has" : "s have"} no drawable box.</Text> : null}
    {detail.annotations.map((annotation) => { const focused = focusedAnnotationId === annotation.id; const drawable = drawableIds.has(annotation.id); return <Pressable key={annotation.id} accessibilityRole="radio" accessibilityState={{ checked: focused }} accessibilityLabel={`Focus annotation ${annotation.id}`} onPress={() => onFocusAnnotation(annotation.id)} style={[styles.quarantineAnnotation, focused && styles.quarantineAnnotationFocused]}><View style={styles.quarantineAnnotationHeader}><Text style={styles.annotationTitle}>{contributionProductLabel(annotation)}</Text>{focused ? <Ionicons name="locate" size={18} color={colors.amber} /> : null}</View><Text style={styles.annotationDetail}>{actionTitle(annotation.action)} · Annotation #{annotation.id}{drawable ? "" : " · Box unavailable"}</Text></Pressable>; })}
  </View>;
}
