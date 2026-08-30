import { Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { AppButton, Card, StatusBadge } from "../../../../components/ui";
import { colors } from "../../../../theme";
import { actionTitle, contributionProductLabel } from "../../annotationUtils";
import { contributionChange, contributionStatus, statusTone, trainingState, trainingStateCopy } from "../../contributionUtils";
import { styles } from "../../styles";
import type { Contribution } from "../../types";

export function ContributionCard({ contribution, displayNameForModel, onViewImage, onEditLabel, onEditBox, allowEditing = true }: {
  contribution: Contribution;
  displayNameForModel: (model: { version?: string | null }) => string;
  onViewImage: () => void;
  onEditLabel: () => void;
  onEditBox: () => void;
  allowEditing?: boolean;
}) {
  const { annotation, submission } = contribution;
  const latestUsage = annotation.training_usages?.[0] ?? submission.training_usages?.[0];
  const displayedStatus = latestUsage ? "used" : submission.status;
  const lifecycleCopy = trainingStateCopy(trainingState(submission));
  const canEdit = allowEditing && submission.status === "pending" && ["RELABEL", "ADD"].includes(annotation.action);
  const canEditBox = allowEditing && submission.status === "pending" && annotation.action === "ADJUST_BOX";
  return <Card>
    <View style={styles.contributionHeader}><View style={[styles.detectionIcon, annotation.action === "REMOVE" && styles.removeIcon]}><Ionicons name={annotation.action === "REMOVE" ? "trash-outline" : "create-outline"} size={22} color={annotation.action === "REMOVE" ? colors.danger : colors.primary} /></View><View style={styles.detectionCopy}><Text style={styles.contributionProduct}>{contributionProductLabel(annotation)}</Text><Text style={styles.contributionAction}>{actionTitle(annotation.action)} · Scan #{submission.scan_id}</Text><Text style={styles.detectionMeta}>{new Date(submission.created_at).toLocaleString("en-GB")}</Text></View><StatusBadge label={contributionStatus(displayedStatus, Boolean(latestUsage))} tone={statusTone(displayedStatus)} /></View>
    <View style={styles.changeStory}><View style={styles.storyStep}><Text style={styles.detailCaption}>MODEL</Text><Text style={styles.storyValue}>{annotation.original_label || "No product"}</Text></View><Ionicons name="arrow-forward" size={17} color={colors.textMuted} /><View style={styles.storyStep}><Text style={styles.detailCaption}>YOU</Text><Text style={styles.storyValue}>{contributionChange(annotation)}</Text></View></View>
    {submission.status === "approved" || submission.status === "used" ? <View style={styles.lifecycleStateRow}><StatusBadge label={lifecycleCopy.label} tone={lifecycleCopy.tone} /><Text style={styles.lifecycleStateText}>{lifecycleCopy.explanation}</Text></View> : null}
    <View style={styles.detectionActions}><View style={styles.detectionAction}><AppButton label="View image" icon="image-outline" variant="secondary" onPress={onViewImage} /></View>{canEdit ? <View style={styles.detectionAction}><AppButton label="Edit label" icon="create-outline" variant="ghost" onPress={onEditLabel} /></View> : null}{canEditBox ? <View style={styles.detectionAction}><AppButton label="Edit box" icon="crop-outline" variant="ghost" onPress={onEditBox} /></View> : null}</View>
    {latestUsage ? <View style={styles.usedModelBox}><Ionicons name="sparkles" size={20} color={colors.successFg} /><View style={styles.detectionCopy}><Text style={styles.usedModelTitle}>Used in {displayNameForModel({ version: latestUsage.model_version })}</Text><Text style={styles.usedModelMeta}>Used for training · This contribution is read-only.</Text></View></View> : null}
    {!latestUsage && submission.status === "used" ? <Text style={styles.readOnlyText}>Used for AI learning · Read-only</Text> : null}
  </Card>;
}
