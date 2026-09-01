import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { LayoutChangeEvent } from "react-native";
import {
  getInventoryBatches,
  updateInventoryBatchRemaining,
  uploadProductRepresentativeImage,
} from "../src/services/api";
import { API_BASE_URL } from "../src/services/config";
import type { InventoryBatchItem } from "../src/types/api";
import { useAuthenticatedImage } from "../src/components/useAuthenticatedImage";
import { confirmAction, showMessage } from "../src/utils/confirm";

const QUICK_LEVELS = [
  { label: "Full", value: 100 },
  { label: "Mostly full", value: 75 },
  { label: "Half", value: 50 },
  { label: "Almost empty", value: 25 },
  { label: "Finished", value: 0 },
];

let sessionHighContrastOutline = false;

function initialHighContrastPreference() {
  try {
    return (globalThis as any).localStorage?.getItem("highContrastOutline") === "true"
      || sessionHighContrastOutline;
  } catch {
    return sessionHighContrastOutline;
  }
}

function expiryDate(batch: InventoryBatchItem) {
  return batch.expiry_date || batch.expiry_estimate_date || "No expiry date";
}

type UnitOption = {
  key: string;
  batch: InventoryBatchItem;
  unitNumber: number;
  unitsWithSameExpiry: number;
  remainingPercent: number | null;
};

function normalizePercentage(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) return null;
  return Math.max(0, Math.min(100, numericValue));
}

function buildUnitOptions(batches: InventoryBatchItem[]): UnitOption[] {
  const totals = new Map<string, number>();
  const counters = new Map<string, number>();
  batches.forEach((batch) => {
    const date = expiryDate(batch);
    totals.set(date, (totals.get(date) || 0) + batch.quantity);
  });

  return batches.flatMap((batch) => Array.from({ length: batch.quantity }, (_, index) => {
    const date = expiryDate(batch);
    const unitNumber = (counters.get(date) || 0) + 1;
    counters.set(date, unitNumber);
    return {
      key: `${batch.id}-${index}`,
      batch,
      unitNumber,
      unitsWithSameExpiry: totals.get(date) || batch.quantity,
      remainingPercent: index === 0
        ? normalizePercentage(batch.open_unit_remaining_percent)
        : null,
    };
  }));
}

function RemainingSlider({
  value,
  onChangeComplete,
}: {
  value: number;
  onChangeComplete: (value: number) => void;
}) {
  const [sliderValue, setSliderValue] = useState(() => normalizePercentage(value) ?? 100);
  const trackRef = useRef<View>(null);
  const trackX = useRef<number | null>(null);
  const trackWidth = useRef<number | null>(null);

  useEffect(() => {
    setSliderValue(normalizePercentage(value) ?? 100);
  }, [value]);

  const valueFromPagePosition = useCallback((pageX: number) => {
    const measuredX = trackX.current;
    const measuredWidth = trackWidth.current;
    if (
      !Number.isFinite(pageX)
      || measuredX === null
      || !Number.isFinite(measuredX)
      || measuredWidth === null
      || !Number.isFinite(measuredWidth)
      || measuredWidth <= 0
    ) return null;
    const raw = ((pageX - measuredX) / measuredWidth) * 100;
    return normalizePercentage(Math.round(raw / 5) * 5);
  }, []);

  function measureTrack(callback?: () => void) {
    trackRef.current?.measureInWindow((x, _y, measuredWidth) => {
      if (!Number.isFinite(x) || !Number.isFinite(measuredWidth) || measuredWidth <= 0) return;
      trackX.current = x;
      trackWidth.current = measuredWidth;
      callback?.();
    });
  }

  function previewPosition(pageX: number) {
    const nextValue = valueFromPagePosition(pageX);
    if (nextValue !== null) setSliderValue(nextValue);
  }

  function finishPosition(pageX: number) {
    const nextValue = valueFromPagePosition(pageX);
    if (nextValue === null) return;
    setSliderValue(nextValue);
    onChangeComplete(nextValue);
  }

  return (
    <View>
      <View
        ref={trackRef}
        style={styles.sliderTouchArea}
        onLayout={(_event: LayoutChangeEvent) => measureTrack()}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(event) => {
          const pageX = event.nativeEvent.pageX;
          measureTrack(() => previewPosition(pageX));
        }}
        onResponderMove={(event) => previewPosition(event.nativeEvent.pageX)}
        onResponderRelease={(event) => finishPosition(event.nativeEvent.pageX)}
        onResponderTerminate={(event) => finishPosition(event.nativeEvent.pageX)}
      >
        <View style={styles.sliderTrack}>
          <View style={[styles.sliderFill, { width: `${sliderValue}%` }]} />
        </View>
        <View style={[styles.sliderThumb, { left: `${sliderValue}%` }]} />
      </View>
      <Text style={styles.sliderValue}>{sliderValue}% remaining</Text>
    </View>
  );
}

export default function AdjustOpenProductScreen() {
  const params = useLocalSearchParams<{ itemId?: string; itemName?: string }>();
  const itemId = Number(params.itemId);
  const itemName = params.itemName || "Product";
  const [batches, setBatches] = useState<InventoryBatchItem[]>([]);
  const [selectedUnitKey, setSelectedUnitKey] = useState<string | null>(null);
  const [remainingPercent, setRemainingPercent] = useState(100);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [highContrastOutline, setHighContrastOutline] = useState(initialHighContrastPreference);

  async function loadBatches(preferredBatchId?: number | null) {
    const allBatches = await getInventoryBatches();
    const productBatches = allBatches.filter(
      (batch) => batch.item_id === itemId && batch.quantity > 0
    );
    setBatches(productBatches);
    const options = buildUnitOptions(productBatches);
    const nextOption = options.find((option) => option.batch.id === preferredBatchId)
      || options[0]
      || null;
    setSelectedUnitKey(nextOption?.key ?? null);
    setRemainingPercent(nextOption?.remainingPercent ?? 100);
  }

  useEffect(() => {
    if (!Number.isFinite(itemId)) {
      setLoading(false);
      return;
    }
    loadBatches()
      .catch((e: any) => Alert.alert("Load failed", e.message || "Could not load product batches."))
      .finally(() => setLoading(false));
  }, [itemId]);

  const unitOptions = buildUnitOptions(batches);
  const selectedUnit = unitOptions.find((option) => option.key === selectedUnitKey) || null;
  const selectedBatch = selectedUnit?.batch || null;
  const imageUri = `${API_BASE_URL}/items/${itemId}/representative-image?v=${imageVersion}`;
  const image = useAuthenticatedImage(imageUri);
  const imageAvailable = image.status !== "ERROR";
  const hasUsableImage = image.status === "LOADED" && Boolean(image.resolvedUri);

  function selectUnit(option: UnitOption) {
    setSelectedUnitKey(option.key);
    setRemainingPercent(option.remainingPercent ?? 100);
  }

  async function persistRemaining(percent: number) {
    if (!selectedBatch) return;
    const validPercent = normalizePercentage(percent);
    if (validPercent === null) {
      Alert.alert("Invalid amount", "Choose a valid remaining amount before saving.");
      return;
    }
    setSaving(true);
    try {
      const result = await updateInventoryBatchRemaining(selectedBatch.id, validPercent);
      setSaving(false);
      await showMessage(
        validPercent === 0 ? "Product finished" : "Amount saved",
        validPercent === 0
          ? `One ${itemName} unit was removed from inventory.`
          : `${itemName} was updated to ${validPercent}% remaining.`,
      );
      await loadBatches(result.batch.id).catch((e: any) =>
        Alert.alert("Refresh failed", e.message || "Could not refresh the product."));
    } catch (e: any) {
      Alert.alert("Update failed", e.message || "Could not update the remaining amount.");
      setSaving(false);
    }
  }

  function chooseLevel(percent: number) {
    const validPercent = normalizePercentage(percent);
    if (validPercent !== null) setRemainingPercent(validPercent);
  }

  async function saveDraft() {
    if (remainingPercent === 0 && selectedBatch) {
      const confirmed = await confirmAction({ title: "Mark product as finished?", message: `This will remove one ${itemName} unit from the ${expiryDate(selectedBatch)} batch.`, confirmText: "Finish", destructive: true });
      if (confirmed) await persistRemaining(0);
      return;
    }
    await persistRemaining(remainingPercent);
  }

  function updateFromImageTap(y: number) {
    if (!Number.isFinite(y)) return;
    const raw = Math.max(0, Math.min(100, 100 - (y / 280) * 100));
    const nextPercent = normalizePercentage(Math.round(raw / 5) * 5);
    if (nextPercent !== null) setRemainingPercent(nextPercent);
  }

  async function addProductImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission required", "Allow photo access to add a product image.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      quality: 0.9,
    });
    if (result.canceled || !result.assets[0]?.uri) return;

    setUploadingImage(true);
    try {
      await uploadProductRepresentativeImage(itemId, result.assets[0].uri);
      setImageVersion((version) => version + 1);
      Alert.alert("Outline created", "The product outline is now available.");
    } catch (e: any) {
      Alert.alert("Image processing failed", e.message || "Could not create a product outline.");
    } finally {
      setUploadingImage(false);
    }
  }

  function toggleHighContrastOutline() {
    const nextValue = !highContrastOutline;
    setHighContrastOutline(nextValue);
    sessionHighContrastOutline = nextValue;
    try {
      (globalThis as any).localStorage?.setItem("highContrastOutline", String(nextValue));
    } catch {
      // Session memory remains available when persistent storage is unavailable.
    }
  }

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" /></View>;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{itemName}</Text>
      <Text style={styles.subtitle}>Choose the expiry batch and adjust its open unit.</Text>

      <Text style={styles.sectionLabel}>Expiry batch</Text>
      <View style={styles.batchOptions}>
        {unitOptions.map((option) => (
          <Pressable
            key={option.key}
            style={[styles.batchOption, selectedUnitKey === option.key && styles.batchOptionSelected]}
            onPress={() => selectUnit(option)}
          >
            <Text style={styles.batchDate}>
              {expiryDate(option.batch)} - Unit {option.unitNumber} of {option.unitsWithSameExpiry}
            </Text>
            <Text style={styles.batchMeta}>
              {option.remainingPercent != null
                ? `Open at ${option.remainingPercent}%`
                : "Full / not tracked as open"}
            </Text>
          </Pressable>
        ))}
      </View>

      {!selectedBatch ? (
        <Text style={styles.empty}>No available inventory batch was found.</Text>
      ) : (
        <>
          <View style={styles.visualCard}>
            <View style={styles.productVisual}>
              {imageAvailable ? (
                <>
                  {image.resolvedUri ? <Image
                    source={{ uri: image.resolvedUri }}
                    style={styles.productImage}
                    tintColor={highContrastOutline ? "#ffffff" : "#d1d5db"}
                    resizeMode="contain"
                    onLoad={image.onLoad}
                    onError={image.onError}
                  /> : null}
                  <View style={[styles.remainingImageClip, { height: `${remainingPercent}%` }]}>
                    {image.resolvedUri ? <Image
                      source={{ uri: image.resolvedUri }}
                      style={styles.filledProductImage}
                      tintColor={highContrastOutline ? "#111111" : undefined}
                      resizeMode="contain"
                      onLoad={image.onLoad}
                      onError={image.onError}
                    /> : null}
                  </View>
                </>
              ) : (
                <View style={styles.placeholder}>
                  <Text style={styles.placeholderIcon}>[ ]</Text>
                  <Text style={styles.placeholderText}>No scan image available for {itemName}</Text>
                  <Pressable style={styles.addImageButton} onPress={image.retry}>
                    <Text style={styles.addImageText}>Retry image</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.addImageButton, uploadingImage && styles.disabled]}
                    onPress={addProductImage}
                    disabled={uploadingImage}
                  >
                    {uploadingImage
                      ? <ActivityIndicator color="#fff" />
                      : <Text style={styles.addImageText}>Add product image</Text>}
                  </Pressable>
                </View>
              )}
              {hasUsableImage && <View
                style={[
                  styles.fillLine,
                  {
                    top: `${100 - remainingPercent}%`,
                    transform: [{
                      translateY: remainingPercent === 0 ? (highContrastOutline ? -6 : -4) : 0,
                    }],
                  },
                  highContrastOutline && styles.fillLineHighContrast,
                ]}
              />}
              {hasUsableImage && (
                <Pressable
                  style={styles.imageTapLayer}
                  onPress={(event) => updateFromImageTap(event.nativeEvent.locationY)}
                />
              )}
            </View>
            <Text style={styles.visualCaption}>
              Filled height, diagonal stripes, and the level line show the amount remaining.
            </Text>
            <Pressable
              style={styles.contrastToggle}
              onPress={toggleHighContrastOutline}
              accessibilityRole="switch"
              accessibilityState={{ checked: highContrastOutline }}
            >
              <View style={[styles.toggleTrack, highContrastOutline && styles.toggleTrackActive]}>
                <View style={[styles.toggleThumb, highContrastOutline && styles.toggleThumbActive]} />
              </View>
              <Text style={styles.contrastToggleText}>High-contrast outline</Text>
            </Pressable>
          </View>

          <Text style={styles.sectionLabel}>Quick update</Text>
          <View style={styles.quickLevels}>
            {QUICK_LEVELS.map((level) => (
              <Pressable
                key={level.value}
                style={[
                  styles.levelButton,
                  level.value === 0 && styles.finishedButton,
                  remainingPercent === level.value && styles.levelButtonSelected,
                ]}
                onPress={() => chooseLevel(level.value)}
                disabled={saving}
              >
                <Text style={[styles.levelText, level.value === 0 && styles.finishedText]}>
                  {level.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.unsavedHint}>
            Drag or tap the slider, or tap the outline. Save when ready.
          </Text>

          <View style={styles.sliderCard}>
            <Text style={styles.sectionLabel}>Precise adjustment</Text>
            <RemainingSlider
              value={remainingPercent}
              onChangeComplete={setRemainingPercent}
            />
            <Pressable
              style={[styles.saveButton, saving && styles.disabled]}
              onPress={saveDraft}
              disabled={saving}
            >
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save amount</Text>}
            </Pressable>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 10, paddingBottom: 40, backgroundColor: "#f8fafc", flexGrow: 1 },
  title: { fontSize: 28, fontWeight: "700", color: "#111827" },
  subtitle: { color: "#6b7280", marginBottom: 4 },
  sectionLabel: { color: "#374151", fontWeight: "700", marginTop: 8 },
  batchOptions: { gap: 8 },
  batchOption: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#d1d5db", borderRadius: 11, padding: 12 },
  batchOptionSelected: { borderColor: "#2563eb", borderWidth: 2, backgroundColor: "#eff6ff" },
  batchDate: { color: "#111827", fontWeight: "700" },
  batchMeta: { color: "#6b7280", marginTop: 4 },
  visualCard: { backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: "#e5e7eb", padding: 12, marginTop: 4 },
  productVisual: { height: 280, backgroundColor: "#f3f4f6", borderRadius: 12, overflow: "hidden", position: "relative" },
  productImage: { width: "100%", height: "100%" },
  remainingImageClip: { position: "absolute", bottom: 0, left: 0, right: 0, overflow: "hidden" },
  filledProductImage: { position: "absolute", bottom: 0, left: 0, right: 0, height: 280 },
  fillLine: { position: "absolute", left: 0, right: 0, height: 4, backgroundColor: "#111827" },
  fillLineHighContrast: { height: 6, backgroundColor: "#000000" },
  visualCaption: { color: "#6b7280", textAlign: "center", fontSize: 13, lineHeight: 18, marginTop: 8 },
  contrastToggle: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 10 },
  contrastToggleText: { color: "#374151", fontWeight: "600", fontSize: 13 },
  toggleTrack: { width: 38, height: 22, borderRadius: 11, backgroundColor: "#9ca3af", padding: 3 },
  toggleTrackActive: { backgroundColor: "#111827" },
  toggleThumb: { width: 16, height: 16, borderRadius: 8, backgroundColor: "#fff" },
  toggleThumbActive: { marginLeft: 16 },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  placeholderIcon: { color: "#9ca3af", fontSize: 50, fontWeight: "300" },
  placeholderText: { color: "#6b7280", textAlign: "center", marginTop: 10 },
  addImageButton: { backgroundColor: "#2563eb", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginTop: 14, minWidth: 160, alignItems: "center" },
  addImageText: { color: "#fff", fontWeight: "700" },
  imageTapLayer: { ...StyleSheet.absoluteFillObject },
  quickLevels: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  levelButton: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#bfdbfe", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 9 },
  levelButtonSelected: { backgroundColor: "#dbeafe", borderColor: "#2563eb" },
  levelText: { color: "#1d4ed8", fontWeight: "700", fontSize: 13 },
  finishedButton: { borderColor: "#fecaca", backgroundColor: "#fff7f7" },
  finishedText: { color: "#b91c1c" },
  unsavedHint: { color: "#6b7280", fontSize: 13, lineHeight: 18, fontStyle: "italic" },
  sliderCard: { backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#e5e7eb", padding: 14, marginTop: 4 },
  sliderTouchArea: { height: 44, justifyContent: "center", marginHorizontal: 10, marginTop: 6 },
  sliderTrack: { height: 9, borderRadius: 5, backgroundColor: "#d1d5db", overflow: "hidden" },
  sliderFill: { height: 9, backgroundColor: "#10b981" },
  sliderThumb: { position: "absolute", marginLeft: -11, width: 22, height: 22, borderRadius: 11, backgroundColor: "#10b981", borderWidth: 3, borderColor: "#fff" },
  sliderValue: { textAlign: "center", color: "#111827", fontWeight: "700", fontSize: 18 },
  saveButton: { backgroundColor: "#10b981", borderRadius: 11, paddingVertical: 13, alignItems: "center", marginTop: 14 },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  disabled: { opacity: 0.6 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { color: "#6b7280", textAlign: "center", marginTop: 30 },
});
