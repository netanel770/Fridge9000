import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { AppButton, Card, EmptyState, StatusBadge } from "../../../../components/ui";
import { DetectionImageViewer } from "../../../../components/DetectionImageViewer";
import type {
  AnnotationSubmission,
  AnnotationSubmissionDetail,
} from "../../../../types/api";
import { getAnnotationSubmissionImageUrl } from "../../../../services/api";
import { colors } from "../../../../theme";
import { formatIsraelTime } from "../../../../utils/date";
import {
  annotationDetection,
  annotationGroupActionTitle,
  combineAnnotationGroup,
  contributionProductLabel,
  formatAnnotationBox,
  groupAnnotationsForDisplay,
} from "../../annotationUtils";
import { styles } from "../../styles";

type SubmissionWithSubmitter = AnnotationSubmission & {
  submitter_display_name?: string | null;
  submitter_email?: string | null;
};

function submittedBy(submission: AnnotationSubmission) {
  const value = submission as SubmissionWithSubmitter;
  return (
    value.submitter_display_name?.trim()
    || value.submitter_email?.trim()
    || "Legacy / unknown user"
  );
}

export function ModerationQueue({
  submissions,
  loading,
  error,
  message,
  moderatingSubmissionId,
  expandedAnnotationIds,
  onReload,
  onModerate,
  onToggleDetails,
}: {
  submissions: AnnotationSubmissionDetail[];
  loading: boolean;
  error: string;
  message: string;
  moderatingSubmissionId: number | null;
  expandedAnnotationIds: Set<number>;
  onReload: () => void;
  onModerate: (
    submissionId: number,
    status: "approved" | "rejected",
  ) => void;
  onToggleDetails: (annotationId: number) => void;
}) {
  return (
    <>
      <View style={styles.moderationDivider}>
        <View style={styles.detectionCopy}>
          <View style={styles.queueTitleRow}>
            <Text style={styles.sectionTitle}>Review queue</Text>
            <StatusBadge
              label={`${submissions.length} PENDING`}
              tone={submissions.length ? "warning" : "neutral"}
            />
          </View>
          <Text style={styles.sectionSubtitle}>
            Approve feedback before it can become training data. Label and
            area changes for the same product are reviewed together.
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onReload}
          hitSlop={8}
        >
          <Ionicons name="refresh" size={21} color={colors.primary} />
        </Pressable>
      </View>

      {message ? (
        <View style={styles.successBox}>
          <Ionicons
            name="checkmark-circle"
            size={20}
            color={colors.successFg}
          />
          <Text style={styles.successText}>{message}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.loadingText}>
            Loading pending submissions...
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <AppButton
            label="Try Again"
            variant="secondary"
            onPress={onReload}
          />
        </View>
      ) : null}

      {!loading && !error && submissions.length === 0 ? (
        <Card>
          <EmptyState
            icon="shield-checkmark-outline"
            title="Moderation queue is clear"
            message="There are no pending annotation submissions to review."
          />
        </Card>
      ) : null}

      {!loading
        && submissions.map((detail) => {
          const groups = groupAnnotationsForDisplay(detail.annotations);
          const effectiveAnnotations = groups.map(combineAnnotationGroup);
          const first = effectiveAnnotations[0];

          return (
            <Card key={detail.submission.id}>
              <View style={styles.moderationHeader}>
                <View style={styles.detectionCopy}>
                  <Text style={styles.detectionLabel}>
                    {first
                      ? contributionProductLabel(first)
                      : "Unlabeled product"}
                    {groups.length > 1 ? ` +${groups.length - 1} more` : ""}
                  </Text>
                  <Text style={styles.contributionAction}>
                    {groups
                      .map((group) => annotationGroupActionTitle(group))
                      .join(" · ")}
                  </Text>
                  <Text style={styles.detectionMeta}>
                    Scan #{detail.submission.scan_id} ·{" "}
                    {formatIsraelTime(detail.submission.created_at)}
                  </Text>
                  <Text style={styles.detectionMeta}>
                    Submitted by {submittedBy(detail.submission)}
                  </Text>
                </View>
                <StatusBadge label="PENDING" tone="warning" />
              </View>

              <DetectionImageViewer
                imageUri={getAnnotationSubmissionImageUrl(
                  detail.submission.id,
                )}
                imageWidth={detail.submission.image_width}
                imageHeight={detail.submission.image_height}
                detections={effectiveAnnotations.map(annotationDetection)}
                style={styles.moderationImage}
              />

              <View style={styles.moderationAnnotations}>
                {groups.map((group) => {
                  const annotation = combineAnnotationGroup(group);
                  const expanded = expandedAnnotationIds.has(annotation.id);
                  const labelChanged =
                    annotation.original_label
                    && annotation.final_label
                    && annotation.original_label.toLocaleLowerCase()
                      !== annotation.final_label.toLocaleLowerCase();

                  return (
                    <View
                      key={`${detail.submission.id}:${annotation.source_detection_id ?? annotation.id}`}
                      style={styles.moderationAnnotation}
                    >
                      <View style={styles.annotationTitleRow}>
                        <View style={styles.detectionCopy}>
                          <Text style={styles.annotationTitle}>
                            {contributionProductLabel(annotation)}
                          </Text>
                          <Text style={styles.annotationDetail}>
                            {annotationGroupActionTitle(group)}
                          </Text>
                        </View>
                      </View>

                      {labelChanged ? (
                        <Text style={styles.annotationDetail}>
                          {annotation.original_label} →{" "}
                          <Text style={styles.annotationValue}>
                            {annotation.final_label}
                          </Text>
                        </Text>
                      ) : null}

                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded }}
                        accessibilityLabel={`${expanded ? "Hide" : "Show"} annotation details for ${contributionProductLabel(annotation)}`}
                        onPress={() => onToggleDetails(annotation.id)}
                        style={styles.detailsToggle}
                      >
                        <Text style={styles.detailsToggleText}>
                          {expanded ? "Hide details" : "Details"}
                        </Text>
                        <Ionicons
                          name={expanded ? "chevron-up" : "chevron-down"}
                          size={16}
                          color={colors.primary}
                        />
                      </Pressable>

                      {expanded ? (
                        <View style={styles.coordinateDetails}>
                          <Text style={styles.annotationDetail}>
                            Original box:{" "}
                            <Text style={styles.annotationValue}>
                              {formatAnnotationBox(annotation, "original")}
                            </Text>
                          </Text>
                          <Text style={styles.annotationDetail}>
                            Final box:{" "}
                            <Text style={styles.annotationValue}>
                              {formatAnnotationBox(annotation, "final")}
                            </Text>
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>

              <View style={styles.moderationActions}>
                <View style={styles.detectionAction}>
                  <AppButton
                    label="Reject"
                    icon="close-circle-outline"
                    variant="danger"
                    disabled={moderatingSubmissionId !== null}
                    loading={
                      moderatingSubmissionId === detail.submission.id
                    }
                    onPress={() =>
                      onModerate(detail.submission.id, "rejected")
                    }
                  />
                </View>
                <View style={styles.detectionAction}>
                  <AppButton
                    label="Approve"
                    icon="checkmark-circle-outline"
                    disabled={moderatingSubmissionId !== null}
                    loading={
                      moderatingSubmissionId === detail.submission.id
                    }
                    onPress={() =>
                      onModerate(detail.submission.id, "approved")
                    }
                  />
                </View>
              </View>
            </Card>
          );
        })}
    </>
  );
}
