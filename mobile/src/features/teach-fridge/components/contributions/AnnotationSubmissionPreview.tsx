import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { DetectionImageViewer } from "../../../../components/DetectionImageViewer";
import { getAnnotationSubmissionImageUrl } from "../../../../services/api";
import type { AnnotationSubmissionDetail } from "../../../../types/api";
import { colors } from "../../../../theme";
import { actionTitle, hasDrawableBox } from "../../annotationUtils";
import {
  buildSubmissionCorrectionObjects,
  type SubmissionCorrectionObject,
} from "../../submissionCorrections";
import { styles } from "../../styles";

function correctionTitle(object: SubmissionCorrectionObject) {
  if (object.kind === "RELABEL_AND_BOX") return "Label + box correction";
  if (object.kind === "RELABEL") return "Label correction";
  if (object.kind === "ADJUST_BOX") return "Box adjustment";
  if (object.kind === "ADD") return "Missed product added";
  if (object.kind === "REMOVE") return "False positive removed";
  return "Confirmed detection";
}

function boxText(
  box: SubmissionCorrectionObject["originalBox"],
): string {
  if (!box) return "None";
  return [box.x1, box.y1, box.x2, box.y2]
    .map((value) => Math.round(value))
    .join(", ");
}

export function AnnotationSubmissionPreview({
  detail,
  focusedAnnotationId,
  onFocusAnnotation,
}: {
  detail: AnnotationSubmissionDetail;
  focusedAnnotationId: number | null;
  onFocusAnnotation: (annotationId: number) => void;
}) {
  const dimensionsValid =
    detail.submission.image_width > 0 && detail.submission.image_height > 0;
  const imageWidth = dimensionsValid ? detail.submission.image_width : 1;
  const imageHeight = dimensionsValid ? detail.submission.image_height : 1;

  const correctionObjects = buildSubmissionCorrectionObjects(detail);

  const drawableDetections = dimensionsValid
    ? correctionObjects
        .map((object) => object.detection)
        .filter(
          (detection): detection is NonNullable<typeof detection> =>
            Boolean(
              detection &&
                hasDrawableBox(detection, imageWidth, imageHeight),
            ),
        )
    : [];

  const focusedObject =
    correctionObjects.find((object) =>
      focusedAnnotationId == null
        ? false
        : object.annotationIds.includes(focusedAnnotationId),
    ) || null;

  const highlightedDetectionId =
    focusedObject?.detection?.id ??
    drawableDetections[0]?.id ??
    null;

  const expectedDrawableCount = correctionObjects.filter(
    (object) => object.kind !== "REMOVE",
  ).length;
  const missingBoxCount =
    expectedDrawableCount - drawableDetections.length;

  return (
    <View style={styles.annotationSubmissionPreview}>
      <Text style={styles.quarantineBoxNotice}>
        {correctionObjects.length} corrected detection
        {correctionObjects.length === 1 ? "" : "s"} ·{" "}
        {detail.annotations.length} change
        {detail.annotations.length === 1 ? "" : "s"}. The image shows the
        reconstructed final training state.
      </Text>

      <DetectionImageViewer
        imageUri={getAnnotationSubmissionImageUrl(detail.submission.id)}
        imageWidth={imageWidth}
        imageHeight={imageHeight}
        detections={drawableDetections}
        highlightedDetectionId={highlightedDetectionId}
        showLabels
        style={[
          styles.quarantineImage,
          { aspectRatio: imageWidth / imageHeight },
        ]}
      />

      {missingBoxCount > 0 ? (
        <Text style={styles.quarantineBoxNotice}>
          {missingBoxCount} final object
          {missingBoxCount === 1 ? " has" : "s have"} no drawable box.
        </Text>
      ) : null}

      {correctionObjects.map((object) => {
        const focused =
          focusedAnnotationId != null &&
          object.annotationIds.includes(focusedAnnotationId);

        const labelChanged =
          object.finalLabel != null &&
          object.originalLabel.toLocaleLowerCase() !==
            object.finalLabel.toLocaleLowerCase();

        const boxChanged =
          object.kind === "ADJUST_BOX" ||
          object.kind === "RELABEL_AND_BOX";

        return (
          <Pressable
            key={object.key}
            accessibilityRole="radio"
            accessibilityState={{ checked: focused }}
            accessibilityLabel={`Focus corrected detection ${object.displayLabel}`}
            onPress={() => onFocusAnnotation(object.primaryAnnotationId)}
            style={[
              styles.quarantineAnnotation,
              focused && styles.quarantineAnnotationFocused,
            ]}
          >
            <View style={styles.quarantineAnnotationHeader}>
              <View style={styles.detectionCopy}>
                <Text style={styles.annotationTitle}>
                  {object.displayLabel}
                </Text>
                <Text style={styles.annotationDetail}>
                  {correctionTitle(object)}
                </Text>
              </View>
              {focused ? (
                <Ionicons name="locate" size={18} color={colors.amber} />
              ) : null}
            </View>

            {labelChanged ? (
              <Text style={styles.annotationDetail}>
                Label: {object.originalLabel} →{" "}
                <Text style={styles.annotationValue}>
                  {object.finalLabel}
                </Text>
              </Text>
            ) : null}

            {boxChanged ? (
              <View style={styles.coordinateDetails}>
                <Text style={styles.annotationDetail}>
                  Original box:{" "}
                  <Text style={styles.annotationValue}>
                    {boxText(object.originalBox)}
                  </Text>
                </Text>
                <Text style={styles.annotationDetail}>
                  Final box:{" "}
                  <Text style={styles.annotationValue}>
                    {boxText(object.finalBox)}
                  </Text>
                </Text>
              </View>
            ) : null}

            {object.kind === "REMOVE" ? (
              <Text style={styles.annotationDetail}>
                This source detection is removed from the final training
                labels.
              </Text>
            ) : null}

            <Text style={styles.annotationDetail}>
              Changes:{" "}
              {object.annotations
                .map(
                  (annotation) =>
                    `${actionTitle(annotation.action)} · #${annotation.id}`,
                )
                .join(" · ")}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
