import { View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { AppButton, Card, StatusBadge } from "../../../../components/ui";
import type { DetectionItem, RecentScan } from "../../../../types/api";
import { formatIsraelTime } from "../../../../utils/date";
import { colors } from "../../../../theme";
import { detectionBox } from "../../annotationUtils";
import { styles } from "../../styles";

export function SuggestionCard({
  detection,
  selectedScan,
  targeted,
  pendingRelabel,
  pendingRemoval,
  pendingBox,
  pendingConfirm,
  onCorrectLabel,
  onRemove,
  onViewImage,
  onAdjustBox,
  onConfirm,
}: {
  detection: DetectionItem;
  selectedScan: RecentScan;
  targeted: boolean;
  pendingRelabel?: { finalLabel: string; submissionId: number };
  pendingRemoval?: number;
  pendingBox?: number;
  pendingConfirm?: number;
  onCorrectLabel: () => void;
  onRemove: () => void;
  onViewImage: () => void;
  onAdjustBox: () => void;
  onConfirm: () => void;
}) {
  return (
    <View style={targeted ? styles.targetedDetection : undefined}>
      <Card>
        <View style={styles.detectionTop}>
          <View style={styles.detectionIcon}>
            <Ionicons name="cube-outline" size={22} color={colors.primary} />
          </View>
          <View style={styles.detectionCopy}>
            <Text style={styles.modelRole}>
              {targeted ? "SELECTED PREDICTION" : "AI PREDICTION"}
            </Text>
            <Text style={styles.detectionLabel}>{detection.label}</Text>
            <Text style={styles.detectionMeta}>
              Scan #{selectedScan.id} · {formatIsraelTime(selectedScan.created_at)}
            </Text>
          </View>
          <StatusBadge
            label={`${Math.round(detection.confidence * 100)}% CONFIDENT`}
            tone="info"
          />
        </View>

        {pendingRelabel ? (
          <View style={styles.pendingRow}>
            <StatusBadge label="Pending" tone="warning" />
            <Text style={styles.pendingText}>
              Suggested label: {pendingRelabel.finalLabel}
            </Text>
          </View>
        ) : null}

        {pendingRemoval ? (
          <View style={styles.falsePositiveRow}>
            <StatusBadge label="Pending" tone="danger" />
            <Text style={styles.falsePositiveText}>
              Submitted as a false-positive detection.
            </Text>
          </View>
        ) : null}

        {pendingBox ? (
          <View style={styles.pendingRow}>
            <StatusBadge label="Pending" tone="warning" />
            <Text style={styles.pendingText}>
              Bounding-box correction submitted for review.
            </Text>
          </View>
        ) : null}

        {pendingConfirm ? (
          <View style={styles.confirmedRow}>
            <StatusBadge label="Submitted" tone="success" />
            <Text style={styles.confirmedText}>
              Detection marked as correct and pending review.
            </Text>
          </View>
        ) : null}

        <View style={styles.detectionActions}>
          <View style={styles.detectionAction}>
            <AppButton
              label="Correct label"
              icon="create-outline"
              variant="secondary"
              disabled={Boolean(pendingConfirm || pendingRemoval)}
              onPress={onCorrectLabel}
            />
          </View>
          <View style={styles.detectionAction}>
            <AppButton
              label={pendingRemoval ? "Submitted" : "Wrong detection"}
              icon={pendingRemoval ? "time-outline" : "trash-outline"}
              variant="danger"
              disabled={Boolean(pendingRemoval || pendingConfirm || pendingRelabel || pendingBox)}
              onPress={onRemove}
            />
          </View>
        </View>

        <View style={styles.detectionActionsSecondary}>
          <View style={styles.detectionAction}>
            <AppButton
              label="View photo"
              icon="image-outline"
              variant="ghost"
              onPress={onViewImage}
            />
          </View>
          <View style={styles.detectionAction}>
            <AppButton
              label={pendingBox ? "Area submitted" : "Adjust area"}
              icon="crop-outline"
              variant="ghost"
              disabled={
                !detectionBox(detection)
                || Boolean(pendingBox)
                || Boolean(pendingConfirm)
                || Boolean(pendingRemoval)
              }
              onPress={onAdjustBox}
            />
          </View>
        </View>

        <View style={styles.confirmAction}>
          <AppButton
            label={
              pendingConfirm
                ? "Submitted as correct"
                : "The AI was correct"
            }
            icon={
              pendingConfirm
                ? "checkmark-circle"
                : "checkmark-circle-outline"
            }
            disabled={Boolean(
              pendingConfirm
              || pendingRelabel
              || pendingRemoval
              || pendingBox,
            )}
            onPress={onConfirm}
          />
        </View>
      </Card>
    </View>
  );
}
