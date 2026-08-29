import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import { AppButton, Card, EmptyState } from "../../../../components/ui";
import type { DetectionItem, RecentScan } from "../../../../types/api";
import { colors } from "../../../../theme";
import { styles } from "../../styles";
import { ScanSelector } from "./ScanSelector";
import { SuggestionCard } from "./SuggestionCard";

export function SuggestionsTab({
  scans,
  selectedScan,
  detections,
  loadingScans,
  loadingDetections,
  error,
  submissionMessage,
  hasTargetedDetection,
  requestedScanId,
  requestedDetectionId,
  pendingRelabels,
  pendingRemovals,
  pendingBoxes,
  pendingConfirms,
  onReload,
  onSelectScan,
  onAddMissed,
  onViewContributions,
  onCorrectLabel,
  onRemove,
  onViewImage,
  onAdjustBox,
  onConfirm,
}: {
  scans: RecentScan[];
  selectedScan: RecentScan | null;
  detections: DetectionItem[];
  loadingScans: boolean;
  loadingDetections: boolean;
  error: string;
  submissionMessage: string;
  hasTargetedDetection: boolean;
  requestedScanId: number;
  requestedDetectionId: number;
  pendingRelabels: Record<number, { finalLabel: string; submissionId: number }>;
  pendingRemovals: Record<number, number>;
  pendingBoxes: Record<number, number>;
  pendingConfirms: Record<number, number>;
  onReload: () => void;
  onSelectScan: (scan: RecentScan) => void;
  onAddMissed: () => void;
  onViewContributions: () => void;
  onCorrectLabel: (detection: DetectionItem) => void;
  onRemove: (detection: DetectionItem) => void;
  onViewImage: (detection: DetectionItem) => void;
  onAdjustBox: (detection: DetectionItem) => void;
  onConfirm: (detection: DetectionItem) => void;
}) {
  return <View style={styles.suggestions}>
    <Card><View style={styles.manualAnnotationCallout}><View style={styles.manualAnnotationIcon}><Ionicons name="create-outline" size={24} color={colors.primary} /></View><View style={styles.detectionCopy}><Text style={styles.manualAnnotationTitle}>Annotate a new image</Text><Text style={styles.sectionSubtitle}>Upload an image and label products yourself. No AI scan required.</Text></View><AppButton label="Start" icon="arrow-forward" onPress={() => router.push("/manual-annotation" as never)} /></View></Card>
    <View style={styles.sectionHeading}><View><Text style={styles.sectionTitle}>What did the AI get wrong?</Text><Text style={styles.sectionSubtitle}>Choose the product and tell us the correct answer.</Text></View><Pressable accessibilityRole="button" onPress={onReload} hitSlop={8}><Ionicons name="refresh" size={21} color={colors.primary} /></Pressable></View>
    {loadingScans ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading recent scans...</Text></View> : null}
    {!loadingScans && scans.length ? <ScanSelector scans={scans} selectedScan={selectedScan} onSelect={onSelectScan} /> : null}
    {selectedScan ? <AppButton label="Add Missed Product" icon="add-circle-outline" variant="secondary" onPress={onAddMissed} /> : null}
    {hasTargetedDetection && selectedScan?.id === requestedScanId ? <View style={styles.targetedHelp}><Ionicons name="sparkles-outline" size={20} color={colors.primary} /><View style={styles.detectionCopy}><Text style={styles.targetedHelpTitle}>Selected from Review</Text><Text style={styles.targetedHelpText}>This prediction was marked “Not included”. Choose the correction below.</Text></View></View> : null}
    {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text><AppButton label="Try Again" variant="secondary" onPress={onReload} /></View> : null}
    {submissionMessage ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><View style={styles.detectionCopy}><Text style={styles.successText}>{submissionMessage}</Text><Pressable onPress={onViewContributions}><Text style={styles.successLink}>View contribution →</Text></Pressable></View></View> : null}
    {!loadingScans && !error && scans.length === 0 ? <Card><EmptyState icon="camera-outline" title="No recent scans" message="Run a product scan first, then return here to view its suggestions." /></Card> : null}
    {loadingDetections ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading detections...</Text></View> : null}
    {!loadingDetections && selectedScan && detections.length === 0 && !error ? <Card><EmptyState icon="search-outline" title="No detections in this scan" message={`Scan #${selectedScan.id} was saved without any supported product detections.`} /></Card> : null}
    {!loadingDetections && selectedScan ? detections.map((detection) => <SuggestionCard
      key={detection.id}
      detection={detection}
      selectedScan={selectedScan}
      targeted={hasTargetedDetection && detection.id === requestedDetectionId}
      pendingRelabel={pendingRelabels[detection.id]}
      pendingRemoval={pendingRemovals[detection.id]}
      pendingBox={pendingBoxes[detection.id]}
      pendingConfirm={pendingConfirms[detection.id]}
      onCorrectLabel={() => onCorrectLabel(detection)}
      onRemove={() => onRemove(detection)}
      onViewImage={() => onViewImage(detection)}
      onAdjustBox={() => onAdjustBox(detection)}
      onConfirm={() => onConfirm(detection)}
    />) : null}
  </View>;
}
