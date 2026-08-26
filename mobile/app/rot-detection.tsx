import { useState } from "react";
import { ActivityIndicator, Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";

import { AppButton, Card, ScreenHeader, StatusBadge } from "../src/components/ui";
import { analyzeFreshness, getInventoryBatches, removeInventoryBatchQuantity } from "../src/services/api";
import { API_BASE_URL } from "../src/services/config";
import { colors, radius, spacing, typography } from "../src/theme";
import type {
  FreshnessAnalysisResponse,
  InventoryBatchItem,
} from "../src/types/api";

function absoluteImageUrl(path: string) {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizedItemName(value: string) {
  const name = value.trim().toLowerCase();
  if (name.endsWith("s")) return name.slice(0, -1);
  return name;
}

export default function RotDetectionScreen() {
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [result, setResult] = useState<FreshnessAnalysisResponse | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [matchingBatches, setMatchingBatches] = useState<InventoryBatchItem[]>([]);
  const [loadingInventory, setLoadingInventory] = useState(false);
  const [removingBatchId, setRemovingBatchId] = useState<number | null>(null);
  const [inventoryMessage, setInventoryMessage] = useState("");
  const [removalBatch, setRemovalBatch] = useState<InventoryBatchItem | null>(null);
  const [removalQuantity, setRemovalQuantity] = useState(1);

  function selectImage(uri: string) {
    setImageUri(uri);
    setResult(null);
    setError("");
    setMatchingBatches([]);
    setInventoryMessage("");
  }

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (permission.status !== "granted") {
      Alert.alert("Permission required", "Camera access is required to photograph fruit.");
      return;
    }
    const selection = await ImagePicker.launchCameraAsync({
      allowsEditing: false,
      quality: 0.9,
    });
    if (!selection.canceled) selectImage(selection.assets[0].uri);
  }

  async function choosePhoto() {
    const selection = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.9,
    });
    if (!selection.canceled) selectImage(selection.assets[0].uri);
  }

  async function runAnalysis() {
    if (!imageUri) return;
    setAnalyzing(true);
    setError("");
    try {
      const analysis = await analyzeFreshness(imageUri);
      setResult(analysis);
      if (analysis.classification.is_rotten) {
        setLoadingInventory(true);
        try {
          const batches = await getInventoryBatches();
          const classifiedName = normalizedItemName(analysis.classification.item);
          setMatchingBatches(batches.filter((batch) => normalizedItemName(batch.name) === classifiedName));
        } catch (inventoryError) {
          setInventoryMessage(inventoryError instanceof Error ? inventoryError.message : "Could not load matching inventory.");
        } finally {
          setLoadingInventory(false);
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Freshness analysis failed";
      setError(message);
    } finally {
      setAnalyzing(false);
    }
  }

  function reset() {
    setImageUri(null);
    setResult(null);
    setError("");
    setMatchingBatches([]);
    setInventoryMessage("");
  }

  async function removeFromBatch(batch: InventoryBatchItem) {
    setRemovingBatchId(batch.id);
    setInventoryMessage("");
    try {
      const removed = removalQuantity;
      await removeInventoryBatchQuantity(batch.id, removed);
      const batches = await getInventoryBatches();
      const classifiedName = normalizedItemName(result?.classification.item || "");
      setMatchingBatches(batches.filter((item) => normalizedItemName(item.name) === classifiedName));
      setInventoryMessage(`Removed ${removed} ${batch.name}${removed === 1 ? "" : "s"} from inventory.`);
      setRemovalBatch(null);
      setRemovalQuantity(1);
    } catch (caught) {
      setInventoryMessage(caught instanceof Error ? caught.message : "Could not remove the item.");
    } finally {
      setRemovingBatchId(null);
    }
  }

  function openRemoval(batch: InventoryBatchItem) {
    setRemovalBatch(batch);
    setRemovalQuantity(1);
    setInventoryMessage("");
  }

  const classification = result?.classification;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <ScreenHeader
        eyebrow="Visual analysis"
        title="Rot Detection"
        subtitle="Photograph fruit to check its visible freshness."
      />

      {!imageUri ? (
        <Card>
          <View style={styles.actionCard}>
            <View style={styles.heroIcon}><Ionicons name="leaf-outline" size={34} color={colors.primary} /></View>
            <Text style={styles.actionTitle}>Add a fruit photo</Text>
            <Text style={styles.actionMessage}>Use a clear image of one apple, banana, or orange.</Text>
            <View style={styles.actions}>
              <AppButton label="Take Photo" icon="camera-outline" onPress={takePhoto} />
              <AppButton label="Choose Photo" icon="images-outline" variant="secondary" onPress={choosePhoto} />
            </View>
          </View>
        </Card>
      ) : (
        <>
          <Card>
            <Image
              source={{ uri: result ? absoluteImageUrl(result.image_url) : imageUri }}
              style={styles.preview}
              resizeMode="contain"
            />
            {!result ? (
              <View style={styles.actions}>
                <AppButton
                  label="Analyze Freshness"
                  icon="search-outline"
                  onPress={runAnalysis}
                  loading={analyzing}
                />
                <AppButton label="Choose Another Photo" variant="ghost" onPress={choosePhoto} disabled={analyzing} />
              </View>
            ) : null}
            {analyzing ? <View style={styles.analyzing}><ActivityIndicator color={colors.primary} /><Text style={styles.analyzingText}>Checking fruit freshness...</Text></View> : null}
            {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text><AppButton label="Try Again" variant="secondary" onPress={runAnalysis} /></View> : null}
          </Card>

          {result && classification ? (
            <>
              <View style={[styles.resultPanel, classification.is_rotten ? styles.rottenPanel : styles.freshPanel]}>
                <View style={[styles.resultIcon, classification.is_rotten ? styles.rottenIcon : styles.freshIcon]}>
                  <Ionicons name={classification.is_rotten ? "warning" : "checkmark-circle"} size={36} color={classification.is_rotten ? colors.danger : colors.successFg} />
                </View>
                <View style={styles.summaryCard}>
                  <StatusBadge label={classification.is_rotten ? "Rot detected" : "No rot detected"} tone={classification.is_rotten ? "danger" : "success"} />
                  <Text style={[styles.summaryTitle, classification.is_rotten && styles.rottenTitle]}>
                    {classification.is_rotten ? `${classification.item} appears rotten` : `${classification.item} appears fresh`}
                  </Text>
                  <Text style={styles.summaryMessage}>
                    {classification.is_rotten
                      ? "The model found visual signs associated with spoilage. Do not consume it if you are unsure."
                      : "The model did not find visual signs of rot in this image."}
                  </Text>
                  <Text style={styles.confidence}>{Math.round(classification.confidence * 100)}% model confidence</Text>
                </View>
              </View>

              {classification.is_rotten ? (
                <Card>
                  <Text style={styles.inventoryTitle}>Remove from inventory</Text>
                  <Text style={styles.inventoryHelp}>Select the exact inventory batch, then choose how many items to remove.</Text>
                  {loadingInventory ? <ActivityIndicator color={colors.primary} /> : null}
                  {!loadingInventory && matchingBatches.length === 0 ? <Text style={styles.inventoryEmpty}>No matching {classification.item} currently appear in inventory. Nothing was removed.</Text> : null}
                  {matchingBatches.map((batch) => (
                    <Pressable key={batch.id} onPress={() => openRemoval(batch)} disabled={removingBatchId !== null} style={styles.batchRow}>
                      <View style={styles.batchCopy}>
                        <Text style={styles.batchName}>{batch.name}</Text>
                        <Text style={styles.batchMeta}>Qty {batch.quantity} · Expires {batch.expiry_date || batch.expiry_estimate_date || "unknown"}</Text>
                      </View>
                      {removingBatchId === batch.id ? <ActivityIndicator color={colors.danger} /> : <Ionicons name="trash-outline" size={22} color={colors.danger} />}
                    </Pressable>
                  ))}
                  {inventoryMessage ? <Text style={[styles.inventoryMessage, inventoryMessage.startsWith("Removed") ? styles.successMessage : styles.failureMessage]}>{inventoryMessage}</Text> : null}
                </Card>
              ) : null}

              <AppButton label="Scan Another Photo" icon="camera-outline" variant="secondary" onPress={reset} />
            </>
          ) : null}
        </>
      )}

      <View style={styles.safetyNote}>
        <Ionicons name="information-circle-outline" size={17} color={colors.textMuted} />
        <Text style={styles.safetyText}>Visual freshness detection cannot confirm food safety.</Text>
      </View>

      <Modal visible={removalBatch !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setRemovalBatch(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Remove from inventory</Text>
            <Text style={styles.modalMessage}>
              {removalBatch?.name} - {removalBatch?.quantity} currently in this batch
            </Text>
            <View style={styles.quantityPicker}>
              <Pressable accessibilityLabel="Decrease quantity" onPress={() => setRemovalQuantity((value) => Math.max(1, value - 1))} style={styles.quantityButton}>
                <Ionicons name="remove" size={25} color={colors.primaryText} />
              </Pressable>
              <View style={styles.quantityValueBox}>
                <Text style={styles.quantityValue}>{removalQuantity}</Text>
                <Text style={styles.quantityCaption}>to remove</Text>
              </View>
              <Pressable accessibilityLabel="Increase quantity" onPress={() => setRemovalQuantity((value) => Math.min(removalBatch?.quantity || 1, value + 1))} style={styles.quantityButton}>
                <Ionicons name="add" size={25} color={colors.primaryText} />
              </Pressable>
            </View>
            <Text style={styles.remainingPreview}>{Math.max(0, (removalBatch?.quantity || 0) - removalQuantity)} will remain in this batch</Text>
            {inventoryMessage && !inventoryMessage.startsWith("Removed") ? <Text style={[styles.inventoryMessage, styles.failureMessage]}>{inventoryMessage}</Text> : null}
            <View style={styles.modalActions}>
              <AppButton label={`Remove ${removalQuantity}`} icon="trash-outline" variant="danger" loading={removingBatchId !== null} onPress={() => removalBatch && removeFromBatch(removalBatch)} />
              <AppButton label="Cancel" variant="ghost" disabled={removingBatchId !== null} onPress={() => setRemovalBatch(null)} />
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.xl, gap: spacing.md, paddingBottom: 44 },
  actionCard: { alignItems: "center", gap: spacing.sm },
  heroIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center", marginBottom: spacing.xs },
  actionTitle: { ...typography.section, color: colors.navy },
  actionMessage: { ...typography.body, color: colors.textMuted, textAlign: "center", lineHeight: 21 },
  actions: { alignSelf: "stretch", gap: spacing.sm, marginTop: spacing.md },
  preview: { width: "100%", height: 320, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted },
  analyzing: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.sm, marginTop: spacing.md },
  analyzingText: { color: colors.textSecondary, fontWeight: "700" },
  errorBox: { gap: spacing.sm, marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.dangerBg },
  errorText: { color: colors.danger, textAlign: "center", fontWeight: "600" },
  summaryCard: { gap: spacing.sm },
  summaryTitle: { ...typography.section, color: colors.navy, marginTop: spacing.xs },
  summaryMessage: { ...typography.body, color: colors.textMuted, lineHeight: 21 },
  resultPanel: { borderRadius: radius.xl, padding: spacing.xl, borderWidth: 2, gap: spacing.md, alignItems: "flex-start" },
  rottenPanel: { backgroundColor: "#fff1f2", borderColor: colors.danger },
  freshPanel: { backgroundColor: "#f0fdf4", borderColor: colors.success },
  resultIcon: { width: 60, height: 60, borderRadius: 30, alignItems: "center", justifyContent: "center" },
  rottenIcon: { backgroundColor: colors.dangerBg },
  freshIcon: { backgroundColor: colors.successBg },
  rottenTitle: { color: colors.danger },
  inventoryTitle: { ...typography.section, color: colors.navy, marginBottom: spacing.xs },
  inventoryHelp: { ...typography.body, color: colors.textMuted, lineHeight: 21, marginBottom: spacing.md },
  inventoryEmpty: { color: colors.textSecondary, backgroundColor: colors.surfaceMuted, padding: spacing.md, borderRadius: radius.lg },
  batchRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  batchCopy: { flex: 1, gap: 3 },
  batchName: { fontWeight: "800", color: colors.navy },
  batchMeta: { fontSize: 13, color: colors.textMuted },
  inventoryMessage: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg, fontWeight: "700" },
  successMessage: { color: colors.successFg, backgroundColor: colors.successBg },
  failureMessage: { color: colors.danger, backgroundColor: colors.dangerBg },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(15, 23, 42, 0.58)", alignItems: "center", justifyContent: "center", padding: spacing.xl },
  modalCard: { width: "100%", maxWidth: 420, backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.xl, gap: spacing.md },
  modalTitle: { ...typography.section, color: colors.navy, textAlign: "center" },
  modalMessage: { ...typography.body, color: colors.textMuted, textAlign: "center" },
  quantityPicker: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.xl, marginVertical: spacing.sm },
  quantityButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  quantityValueBox: { minWidth: 82, alignItems: "center" },
  quantityValue: { fontSize: 30, fontWeight: "800", color: colors.navy },
  quantityCaption: { color: colors.textMuted, fontSize: 13 },
  remainingPreview: { color: colors.textSecondary, textAlign: "center", fontWeight: "600" },
  modalActions: { gap: spacing.sm, marginTop: spacing.sm },
  confidence: { fontSize: 13, color: colors.textMuted },
  safetyNote: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, paddingHorizontal: spacing.md, marginTop: spacing.sm },
  safetyText: { color: colors.textMuted, fontSize: 13, lineHeight: 18, flexShrink: 1 },
});
