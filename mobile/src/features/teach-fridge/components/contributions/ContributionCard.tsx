import { Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { AppButton, Card, StatusBadge } from "../../../../components/ui";
import { colors } from "../../../../theme";
import type { AnnotationSubmission } from "../../../../types/api";
import { formatIsraelTime, parseApiDate } from "../../../../utils/date";
import {
  contributionActionTitle,
  contributionProductLabelForContribution,
} from "../../annotationUtils";
import {
  contributionChange,
  contributionStatus,
  statusTone,
  trainingState,
  trainingStateCopy,
} from "../../contributionUtils";
import { styles } from "../../styles";
import type { Contribution } from "../../types";

type SubmissionWithSubmitter = AnnotationSubmission & {
  submitter_display_name?: string | null;
  submitter_email?: string | null;
};

export function ContributionCard({
  contribution,
  displayNameForModel,
  onViewImage,
  onEditLabel,
  onEditBox,
  allowEditing = true,
  showSubmitter = false,
}: {
  contribution: Contribution;
  displayNameForModel: (model: { version?: string | null }) => string;
  onViewImage: () => void;
  onEditLabel: () => void;
  onEditBox: () => void;
  allowEditing?: boolean;
  showSubmitter?: boolean;
}) {
  const { annotation, annotations, submission } = contribution;
  const usages = annotations
    .flatMap((item) => item.training_usages || [])
    .sort(
      (left, right) =>
        parseApiDate(right.used_at).getTime() - parseApiDate(left.used_at).getTime(),
    );
  const latestUsage = usages[0] ?? submission.training_usages?.[0];
  const displayedStatus = latestUsage ? "used" : submission.status;
  const lifecycleCopy = trainingStateCopy(trainingState(submission));
  const canEdit =
    allowEditing
    && submission.status === "pending"
    && annotations.some((item) => ["RELABEL", "ADD"].includes(item.action));
  const canEditBox =
    allowEditing
    && submission.status === "pending"
    && annotations.some((item) => item.action === "ADJUST_BOX");

  const submitterSubmission = submission as SubmissionWithSubmitter;
  const submitterName =
    submitterSubmission.submitter_display_name?.trim()
    || submitterSubmission.submitter_email?.trim()
    || "Legacy / unknown user";

  return (
    <Card>
      <View style={styles.contributionHeader}>
        <View
          style={[
            styles.detectionIcon,
            annotations.some((item) => item.action === "REMOVE")
              && styles.removeIcon,
          ]}
        >
          <Ionicons
            name={
              annotations.some((item) => item.action === "REMOVE")
                ? "trash-outline"
                : "create-outline"
            }
            size={22}
            color={
              annotations.some((item) => item.action === "REMOVE")
                ? colors.danger
                : colors.primary
            }
          />
        </View>
        <View style={styles.detectionCopy}>
          <Text style={styles.contributionProduct}>
            {contributionProductLabelForContribution(contribution)}
          </Text>
          <Text style={styles.contributionAction}>
            {contributionActionTitle(contribution)} · Scan #{submission.scan_id}
          </Text>
          <Text style={styles.detectionMeta}>
            {formatIsraelTime(submission.created_at)}
          </Text>
        </View>
        <StatusBadge
          label={contributionStatus(displayedStatus, Boolean(latestUsage))}
          tone={statusTone(displayedStatus)}
        />
      </View>

      <View style={styles.changeStory}>
        <View style={styles.storyStep}>
          <Text style={styles.detailCaption}>MODEL</Text>
          <Text style={styles.storyValue}>
            {annotation.original_label || "No product"}
          </Text>
        </View>
        <Ionicons
          name="arrow-forward"
          size={17}
          color={colors.textMuted}
        />
        <View style={styles.storyStep}>
          <Text style={styles.detailCaption}>
            {showSubmitter ? "SUBMITTED BY" : "YOU"}
          </Text>
          <Text style={styles.storyValue}>
            {showSubmitter ? submitterName : contributionChange(contribution)}
          </Text>
          {showSubmitter ? (
            <Text style={styles.detectionMeta}>
              {contributionChange(contribution)}
            </Text>
          ) : null}
        </View>
      </View>

      {submission.status === "approved" || submission.status === "used" ? (
        <View style={styles.lifecycleStateRow}>
          <StatusBadge label={lifecycleCopy.label} tone={lifecycleCopy.tone} />
          <Text style={styles.lifecycleStateText}>
            {lifecycleCopy.explanation}
          </Text>
        </View>
      ) : null}

      <View style={styles.detectionActions}>
        <View style={styles.detectionAction}>
          <AppButton
            label="View image"
            icon="image-outline"
            variant="secondary"
            onPress={onViewImage}
          />
        </View>
        {canEdit ? (
          <View style={styles.detectionAction}>
            <AppButton
              label="Edit label"
              icon="create-outline"
              variant="ghost"
              onPress={onEditLabel}
            />
          </View>
        ) : null}
        {canEditBox ? (
          <View style={styles.detectionAction}>
            <AppButton
              label="Edit box"
              icon="crop-outline"
              variant="ghost"
              onPress={onEditBox}
            />
          </View>
        ) : null}
      </View>

      {latestUsage ? (
        <View style={styles.usedModelBox}>
          <Ionicons name="sparkles" size={20} color={colors.successFg} />
          <View style={styles.detectionCopy}>
            <Text style={styles.usedModelTitle}>
              Used in {displayNameForModel({ version: latestUsage.model_version })}
            </Text>
            <Text style={styles.usedModelMeta}>
              Used for training · This contribution is read-only.
            </Text>
          </View>
        </View>
      ) : null}

      {!latestUsage && submission.status === "used" ? (
        <Text style={styles.readOnlyText}>
          Used for AI learning · Read-only
        </Text>
      ) : null}
    </Card>
  );
}
