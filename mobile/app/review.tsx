import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  TextInput,
  Switch,
  Pressable,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  BackHandler,
} from "react-native";

import { Stack, router, useLocalSearchParams } from "expo-router";
import { usePreventRemove } from "@react-navigation/native";

import {
  getScanDetections,
  getAllInventory,
  getInventoryBatches,
  submitReview,
  checkDetectionFreshness,
} from "../src/services/api";
import { ProductLabelInput } from "../src/components/ProductLabelInput";
import { useAuthenticatedImage } from "../src/components/useAuthenticatedImage";
import { useAuth } from "../src/features/auth/AuthContext";

import { API_BASE_URL } from "../src/services/config";

import type { DetectionItem, FreshnessClassification, InventoryBatchItem, ReviewItem } from "../src/types/api";

function normalizeItemName(value: string) {
  return value.trim().toLowerCase();
}

function BoxedDetectionImage({ scanId, detectionId }: { scanId: number; detectionId: number }) {
  const image = useAuthenticatedImage(`${API_BASE_URL}/scans/${scanId}/detections/${detectionId}/boxed`);
  if (!image.resolvedUri) {
    return image.status === "ERROR" ? (
      <Pressable style={styles.imageRetry} onPress={image.retry} accessibilityRole="button">
        <Text>Image unavailable - tap to retry</Text>
      </Pressable>
    ) : null;
  }
  return <Image testID={`boxed-detection-image-${detectionId}`} source={{ uri: image.resolvedUri }} style={styles.detectedImage} resizeMode="contain" onLoad={image.onLoad} onError={image.onError} />;
}

function getBatchExpiryDate(batch: InventoryBatchItem) {
  return batch.expiry_date || batch.expiry_estimate_date || null;
}

const UNKNOWN_EXPIRY_KEY = "__unknown_expiry__";
type RemovalExpiryOption = { key: string; date: string | null; label: string; quantity: number };
type FreshnessState =
  | { status: "success"; classification: FreshnessClassification }
  | { status: "error"; message: string };

function isValidFreshnessClassification(value: unknown): value is FreshnessClassification {
  if (!value || typeof value !== "object") return false;
  const classification = value as Partial<FreshnessClassification>;
  return (
    typeof classification.predicted_class === "string" &&
    classification.predicted_class.trim().length > 0 &&
    typeof classification.confidence === "number" &&
    Number.isFinite(classification.confidence) &&
    classification.confidence >= 0 &&
    classification.confidence <= 1
  );
}

function selectedRemovalKey(item: ReviewItem) {
  return item.expiry_source === "inventory_unknown" ? UNKNOWN_EXPIRY_KEY : item.expiry_date || "";
}

function getSuggestedExpiryDate(itemName: string) {
  const name = itemName.toLowerCase();
  const today = new Date();

  if (["milk", "yogurt", "cream", "cheese", "butter"].some((token) => name.includes(token))) {
    today.setDate(today.getDate() + 7);
  } else if (["meat", "chicken", "fish", "salami", "ham"].some((token) => name.includes(token))) {
    today.setDate(today.getDate() + 3);
  } else if (["tomato", "cucumber", "lettuce", "avocado", "apple", "banana", "orange", "carrot", "eggplant"].some((token) => name.includes(token))) {
    today.setDate(today.getDate() + 5);
  } else if (["bread", "pita", "bun", "bagel"].some((token) => name.includes(token))) {
    today.setDate(today.getDate() + 3);
  } else {
    today.setDate(today.getDate() + 14);
  }

  return today.toISOString().split("T")[0];
}

export default function ReviewScreen() {
  const { user } = useAuth();
  const { mode, scanId: scanIdParam, source } = useLocalSearchParams<{
    mode?: "Added" | "Removed";
    scanId?: string;
    source?: "scan" | "receipt";
  }>();

  const parsedScanId = Number(scanIdParam);
  const scanId = Number.isInteger(parsedScanId) && parsedScanId > 0 ? parsedScanId : null;
  const isReceiptReview = source === "receipt";
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [inventoryBatches, setInventoryBatches] = useState<InventoryBatchItem[]>([]);
  const [labelSuggestions, setLabelSuggestions] = useState<string[]>([]);
  const [openExpiryPicker, setOpenExpiryPicker] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [activeFreshnessDetectionId, setActiveFreshnessDetectionId] = useState<number | null>(null);
  const [freshnessByDetectionId, setFreshnessByDetectionId] = useState<Record<number, FreshnessState>>({});
  const freshnessRequestInFlight = useRef(false);
  const mounted = useRef(true);
  const freshnessLocked = activeFreshnessDetectionId !== null;

  usePreventRemove(freshnessLocked, () => {});

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!freshnessLocked) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [freshnessLocked]);

  async function loadData() {
    setLoading(true);
    setError("");

    try {
      if (!scanId) {
        setError("No valid scan ID was provided");
        return;
      }

      const [detections, batches, inventory] = await Promise.all([
        getScanDetections(scanId),
        mode === "Removed" ? getInventoryBatches() : Promise.resolve([]),
        getAllInventory(),
      ]);

      setInventoryBatches(batches);
      setLabelSuggestions(inventory.map((item) => item.name));

      const removalAvailability = new Map<string, { key: string; date: string | null; remaining: number }[]>();
      if (mode === "Removed") {
        batches.forEach((batch) => {
          const date = getBatchExpiryDate(batch);
          if (batch.quantity <= 0) return;
          const key = date || UNKNOWN_EXPIRY_KEY;
          const name = normalizeItemName(batch.name);
          const options = removalAvailability.get(name) || [];
          const existing = options.find((option) => option.key === key);
          if (existing) existing.remaining += batch.quantity;
          else options.push({ key, date, remaining: batch.quantity });
          options.sort((a, b) => a.key === UNKNOWN_EXPIRY_KEY ? 1 : b.key === UNKNOWN_EXPIRY_KEY ? -1 : a.key.localeCompare(b.key));
          removalAvailability.set(name, options);
        });
      }

      const detectionsForReview: Array<DetectionItem & { quantity?: number }> = isReceiptReview
        ? [...detections.reduce((groups, detection) => {
            const key = normalizeItemName(detection.label);
            const existing = groups.get(key);
            if (existing) {
              existing.quantity = (existing.quantity || 1) + 1;
              existing.confidence = Math.max(existing.confidence, detection.confidence);
            } else {
              groups.set(key, { ...detection, quantity: 1 });
            }
            return groups;
          }, new Map<string, DetectionItem & { quantity: number }>()).values()]
        : detections;

      const reviewItems: ReviewItem[] = detectionsForReview.map((d) => {
        const suggestedExpiry = mode === "Removed" ? null : getSuggestedExpiryDate(d.label);
        const removalOption = mode === "Removed"
          ? removalAvailability.get(normalizeItemName(d.label))?.find((option) => option.remaining > 0)
          : undefined;
        if (removalOption) removalOption.remaining -= 1;
        return {
          id: d.id,
          original_label: d.label,
          final_label: d.label,
          included: true,
          confidence: d.confidence,
          x1: d.x1,
          y1: d.y1,
          x2: d.x2,
          y2: d.y2,
          expiry_date: removalOption?.date ?? suggestedExpiry,
          expiry_estimate_date: mode === "Removed" ? null : suggestedExpiry,
          expiry_source: mode === "Removed" ? (removalOption ? (removalOption.date ? "inventory" : "inventory_unknown") : null) : "estimated",
          quantity: isReceiptReview ? d.quantity || 1 : undefined,
          freshness_supported: d.freshness_supported === true,
        };
      });

      setItems(reviewItems);
    } catch (e: any) {
      setError(e.message || "Failed to load detections");
    } finally {
      setLoading(false);
    }
  }

  function getExpiryOptions(item: ReviewItem) {
    const quantities = new Map<string, RemovalExpiryOption>();
    const itemName = normalizeItemName(item.final_label || item.original_label);

    inventoryBatches.forEach((batch) => {
      const expiryDate = getBatchExpiryDate(batch);
      if (normalizeItemName(batch.name) === itemName && batch.quantity > 0) {
        const key = expiryDate || UNKNOWN_EXPIRY_KEY;
        const existing = quantities.get(key);
        if (existing) existing.quantity += batch.quantity;
        else quantities.set(key, { key, date: expiryDate, label: expiryDate || "Unknown expiry", quantity: batch.quantity });
      }
    });

    return [...quantities.values()]
      .sort((a, b) => a.key === UNKNOWN_EXPIRY_KEY ? 1 : b.key === UNKNOWN_EXPIRY_KEY ? -1 : a.key.localeCompare(b.key));
  }

  function selectRemovalExpiry(index: number, option: RemovalExpiryOption) {
    const item = items[index];
    const itemName = normalizeItemName(item.final_label || item.original_label);
    const available = option.quantity;
    const alreadySelected = items.filter((candidate, candidateIndex) =>
      candidateIndex !== index &&
      candidate.included &&
      normalizeItemName(candidate.final_label || candidate.original_label) === itemName &&
      selectedRemovalKey(candidate) === option.key
    ).length;

    if (alreadySelected >= available) {
      Alert.alert(
        "Expiry date unavailable",
        `Only ${available} ${item.final_label || item.original_label} item(s) with ${option.label.toLowerCase()} are in inventory.`,
      );
      return;
    }

    setItems((previous) => previous.map((candidate, candidateIndex) =>
      candidateIndex === index
        ? {
            ...candidate,
            expiry_date: option.date,
            expiry_estimate_date: null,
            expiry_source: option.date ? "inventory" : "inventory_unknown",
          }
        : candidate
    ));
    setOpenExpiryPicker(null);
  }

  function validateRemovalSelections() {
    const usage = new Map<string, number>();

    for (const item of items) {
      if (!item.included) continue;
      const selectedKey = selectedRemovalKey(item);
      if (!selectedKey) {
        Alert.alert(
          "Missing inventory batch",
          `Please select an inventory batch for ${item.final_label || item.original_label}.`,
        );
        return false;
      }

      const name = normalizeItemName(item.final_label || item.original_label);
      const key = `${name}|${selectedKey}`;
      usage.set(key, (usage.get(key) || 0) + 1);
      const available = getExpiryOptions(item).find(
        (option) => option.key === selectedKey
      )?.quantity || 0;

      if ((usage.get(key) || 0) > available) {
        Alert.alert(
          "Not enough inventory",
          `Only ${available} ${item.final_label || item.original_label} item(s) in the selected batch are in inventory.`,
        );
        return false;
      }
    }

    return true;
  }

  useEffect(() => {
    loadData();
  }, []);

  function updateItem(
    index: number,
    field: keyof ReviewItem,
    value: string | boolean | number
  ) {
    if (freshnessRequestInFlight.current) return;
    setItems((prev) => {
      const updated = [...prev];

      updated[index] = {
        ...updated[index],
        [field]: value,
      } as ReviewItem;

      return updated;
    });
  }

  async function handleFreshnessCheck(detectionId: number) {
    if (!scanId || freshnessRequestInFlight.current) return;
    freshnessRequestInFlight.current = true;
    setActiveFreshnessDetectionId(detectionId);
    setFreshnessByDetectionId((previous) => {
      const next = { ...previous };
      delete next[detectionId];
      return next;
    });
    try {
      const response = await checkDetectionFreshness(scanId, detectionId);
      if (!isValidFreshnessClassification(response?.classification)) {
        throw new Error("The freshness service returned an invalid result.");
      }
      if (!mounted.current) return;
      setFreshnessByDetectionId((previous) => ({
        ...previous,
        [detectionId]: { status: "success", classification: response.classification },
      }));
    } catch (caught) {
      if (!mounted.current) return;
      setFreshnessByDetectionId((previous) => ({
        ...previous,
        [detectionId]: {
          status: "error",
          message: caught instanceof Error ? caught.message : "Freshness check failed.",
        },
      }));
    } finally {
      freshnessRequestInFlight.current = false;
      if (mounted.current) setActiveFreshnessDetectionId(null);
    }
  }

  async function handleSubmit() {
    if (freshnessRequestInFlight.current) return;
    if (!scanId) {
      Alert.alert("Missing scan", "No valid scan found.");
      return;
    }

    if (mode === "Removed" && !validateRemovalSelections()) {
      return;
    }

    if (isReceiptReview && items.some((item) => item.included && (!Number.isInteger(item.quantity) || (item.quantity || 0) < 1))) {
      Alert.alert("Invalid quantity", "Every included receipt product must have a quantity of at least 1.");
      return;
    }

    setSubmitting(true);

    try {
      await submitReview(scanId, items, mode || "Added", isReceiptReview ? "receipt" : "scan");

      Alert.alert("Success", "Inventory updated successfully.");

      router.replace("/");
    } catch (e: any) {
      Alert.alert("Submit failed", e.message || "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>

        <Pressable style={styles.retryButton} onPress={loadData}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      pointerEvents={freshnessLocked ? "none" : "auto"}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <Stack.Screen options={{
        gestureEnabled: !freshnessLocked,
        headerBackVisible: !freshnessLocked,
      }} />
      <FlatList
        data={items}
        keyExtractor={(_, index) => String(index)}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        ListHeaderComponent={isReceiptReview ? (
          <View style={styles.reviewHeader}>
            <Text style={styles.reviewTitle}>Receipt review</Text>
            <Text style={styles.reviewSubtitle}>Confirm each product and quantity before submitting.</Text>
          </View>
        ) : null}
        renderItem={({ item, index }) => {
          const freshnessState = freshnessByDetectionId[item.id];
          const freshnessLoading = activeFreshnessDetectionId === item.id;
          return (
          <View style={styles.card}>
            {scanId && item.id && item.x1 != null && (
              <View style={styles.imageBox}>
                <BoxedDetectionImage scanId={scanId} detectionId={item.id} />
              </View>
            )}

            <Text style={styles.label}>Original label</Text>
            <Text style={styles.originalValue}>{item.original_label}</Text>

            {!isReceiptReview && (
              <>
                <Text style={styles.label}>Confidence</Text>
                <Text style={styles.confidenceText}>{(item.confidence ?? 0).toFixed(2)}</Text>
              </>
            )}

            {!isReceiptReview && item.freshness_supported === true ? (
              <View style={styles.freshnessArea}>
                {freshnessLoading ? (
                  <ActivityIndicator accessibilityLabel={`Checking freshness for ${item.original_label}`} color="#2563eb" />
                ) : freshnessState?.status === "success" ? (
                  <View style={styles.freshnessPill}>
                    <Text style={styles.freshnessPillText}>
                      {freshnessState.classification.predicted_class} · {Math.round(freshnessState.classification.confidence * 100)}%
                    </Text>
                  </View>
                ) : (
                  <View>
                    {freshnessState?.status === "error" ? (
                      <Text style={styles.freshnessError}>{freshnessState.message}</Text>
                    ) : null}
                    <Pressable
                      accessibilityRole="button"
                      style={[styles.freshnessButton, freshnessLocked && styles.disabledButton]}
                      onPress={() => handleFreshnessCheck(item.id)}
                      disabled={freshnessLocked}
                    >
                      <Text style={styles.freshnessButtonText}>
                        {freshnessState?.status === "error" ? "Retry Freshness" : "Check Freshness"}
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ) : null}

            {isReceiptReview && (
              <>
                <Text style={styles.label}>Quantity</Text>
                <View style={styles.quantityRow}>
                  <Pressable
                    style={styles.quantityButton}
                    onPress={() => updateItem(index, "quantity", Math.max(1, (item.quantity || 1) - 1))}
                    disabled={freshnessLocked}
                  >
                    <Text style={styles.quantityButtonText}>−</Text>
                  </Pressable>
                  <TextInput
                    value={String(item.quantity || 1)}
                    onChangeText={(text) => updateItem(index, "quantity", Math.max(1, Number.parseInt(text.replace(/\D/g, ""), 10) || 1))}
                    keyboardType="number-pad"
                    selectTextOnFocus
                    style={styles.quantityInput}
                    editable={!freshnessLocked}
                  />
                  <Pressable
                    style={styles.quantityButton}
                    onPress={() => updateItem(index, "quantity", Math.min(999, (item.quantity || 1) + 1))}
                    disabled={freshnessLocked}
                  >
                    <Text style={styles.quantityButtonText}>+</Text>
                  </Pressable>
                </View>
              </>
            )}

            <Text style={styles.label}>Final label</Text>
            <ProductLabelInput
              value={item.final_label}
              onChangeText={(text) => updateItem(index, "final_label", text)}
              suggestions={labelSuggestions}
              disabled={item.included || freshnessLocked}
              accessibilityLabel={`Final product label for ${item.original_label}`}
            />

            <Text style={styles.label}>
              {mode === "Removed" ? "Expiry date in inventory" : "Estimated expiry date"}
            </Text>
            {mode === "Removed" ? (
              <View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Select expiry for ${item.original_label}`}
                  style={styles.expirySelect}
                  onPress={() => setOpenExpiryPicker(openExpiryPicker === index ? null : index)}
                  disabled={freshnessLocked}
                >
                  <Text style={selectedRemovalKey(item) ? styles.expirySelectText : styles.placeholderText}>
                    {item.expiry_source === "inventory_unknown" ? "Unknown expiry" : item.expiry_date || "Select inventory batch"}
                  </Text>
                  <Text style={styles.chevron}>{openExpiryPicker === index ? "-" : "+"}</Text>
                </Pressable>
                {openExpiryPicker === index && (
                  <View style={styles.expiryOptions}>
                    {getExpiryOptions(item).length > 0 ? getExpiryOptions(item).map((option) => (
                      <Pressable
                        key={option.key}
                        style={styles.expiryOption}
                        onPress={() => selectRemovalExpiry(index, option)}
                        disabled={freshnessLocked}
                      >
                        <Text style={styles.expiryOptionDate}>{option.label}</Text>
                        <Text style={styles.expiryOptionQuantity}>Available: {option.quantity}</Text>
                      </Pressable>
                    )) : (
                      <Text style={styles.noExpiryOptions}>No dated inventory is available for this item.</Text>
                    )}
                  </View>
                )}
              </View>
            ) : (
              <TextInput
                value={item.expiry_date ?? ""}
                onChangeText={(text) => updateItem(index, "expiry_date", text)}
                placeholder="YYYY-MM-DD"
                style={styles.input}
                autoCapitalize="none"
                editable={!freshnessLocked}
              />
            )}

            <View style={styles.switchRow}>
              <View>
                <Text style={styles.label}>{item.included ? "Included" : "Not included"}</Text>
                {!item.included && !isReceiptReview ? <Text style={styles.excludedHint}>Help the AI understand why this prediction was wrong.</Text> : null}
              </View>
              <Switch
                accessibilityLabel={`Include ${item.original_label}`}
                value={item.included}
                onValueChange={(value) => updateItem(index, "included", value)}
                disabled={freshnessLocked}
              />
            </View>
            {!item.included && !isReceiptReview && scanId && item.id ? (
              <Pressable
                accessibilityRole="button"
                style={styles.itemTeachButton}
                onPress={() => router.push({ pathname: (user?.is_system_admin ? "/teach-fridge" : "/teach-user") as never, params: { scanId: String(scanId), detectionId: String(item.id) } })}
                disabled={freshnessLocked}
              >
                <Text style={styles.itemTeachButtonText}>Teach AI about this product</Text>
              </Pressable>
            ) : null}
          </View>
        );}}
        ListEmptyComponent={(
          <View style={styles.teachEmptyCard}>
            <View style={styles.teachEmptyIcon}><Text style={styles.teachEmptyEmoji}>✨</Text></View>
            <Text style={styles.teachEmptyTitle}>We couldn’t identify this product</Text>
            <Text style={styles.teachEmptyMessage}>Would you like to teach Fridge 9000 what is in this photo?</Text>
            {!isReceiptReview && scanId ? (
              <Pressable
                accessibilityRole="button"
                style={styles.teachButton}
                onPress={() => router.push({ pathname: (user?.is_system_admin ? "/teach-fridge" : "/teach-user") as never, params: { scanId: String(scanId), addMissed: "1" } })}
              >
                <Text style={styles.teachButtonText}>Teach the AI</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      />

      {items.length > 0 ? <Pressable
        accessibilityRole="button"
        accessibilityLabel="Submit Review"
        accessibilityState={{ disabled: submitting || freshnessLocked, busy: submitting }}
        style={[styles.submitButton, (submitting || freshnessLocked) && styles.disabledButton]}
        onPress={handleSubmit}
        disabled={submitting || freshnessLocked}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>Submit Review</Text>
        )}
      </Pressable> : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  listContent: {
    padding: 16,
    gap: 12,
    paddingBottom: 100,
  },
  reviewHeader: {
    backgroundColor: "#eff6ff",
    borderRadius: 14,
    padding: 14,
    marginBottom: 4,
  },
  reviewTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1e3a8a",
  },
  reviewSubtitle: {
    fontSize: 14,
    color: "#1e40af",
    lineHeight: 18,
    marginTop: 4,
  },
  teachEmptyCard: { marginTop: 28, padding: 24, borderRadius: 18, borderWidth: 1, borderColor: "#bfdbfe", backgroundColor: "#eff6ff", alignItems: "center", gap: 10 },
  teachEmptyIcon: { width: 58, height: 58, borderRadius: 20, backgroundColor: "#dbeafe", alignItems: "center", justifyContent: "center", marginBottom: 4 },
  teachEmptyEmoji: { fontSize: 28 },
  teachEmptyTitle: { color: "#172554", fontSize: 20, fontWeight: "800", textAlign: "center" },
  teachEmptyMessage: { color: "#475569", fontSize: 14, lineHeight: 20, textAlign: "center", marginBottom: 6 },
  teachButton: { width: "100%", minHeight: 50, borderRadius: 12, backgroundColor: "#2563eb", alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  teachButtonText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  card: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  freshnessArea: {
    minHeight: 44,
    justifyContent: "center",
    marginTop: 10,
  },
  freshnessButton: {
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: "#2563eb",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  freshnessButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  freshnessPill: {
    alignSelf: "flex-start",
    borderRadius: 999,
    backgroundColor: "#dcfce7",
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  freshnessPillText: {
    color: "#166534",
    fontSize: 14,
    fontWeight: "700",
  },
  freshnessError: {
    color: "#b91c1c",
    fontSize: 13,
    marginBottom: 6,
  },
  imageBox: {
    width: "100%",
    height: 260,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#e5e7eb",
    marginBottom: 12,
  },
  detectedImage: {
    width: "100%",
    height: "100%",
  },
  imageRetry: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 6,
  },
  originalValue: {
    fontSize: 16,
    color: "#111827",
    marginBottom: 12,
  },
  confidenceText: {
    fontSize: 15,
    color: "#2563eb",
    fontWeight: "700",
    marginBottom: 12,
  },
  quantityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  quantityButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#bfdbfe",
    alignItems: "center",
    justifyContent: "center",
  },
  quantityButtonText: {
    color: "#2563eb",
    fontSize: 22,
    fontWeight: "700",
  },
  quantityInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    backgroundColor: "#fff",
    color: "#111827",
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
  },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
    color: "#111827",
    fontSize: 16,
    marginBottom: 12,
  },
  disabledInput: {
    backgroundColor: "#f3f4f6",
    color: "#6b7280",
  },
  enabledInput: {
    backgroundColor: "#fff",
  },
  expirySelect: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 12,
    backgroundColor: "#fff",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  expirySelectText: {
    color: "#111827",
  },
  placeholderText: {
    color: "#9ca3af",
  },
  chevron: {
    color: "#6b7280",
    fontSize: 12,
  },
  expiryOptions: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    marginTop: -6,
    marginBottom: 12,
    overflow: "hidden",
    backgroundColor: "#fff",
  },
  expiryOption: {
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e7eb",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  expiryOptionDate: {
    color: "#111827",
    fontWeight: "600",
    flex: 1,
    flexShrink: 1,
  },
  expiryOptionQuantity: {
    color: "#6b7280",
  },
  noExpiryOptions: {
    color: "#b91c1c",
    padding: 12,
  },
  switchRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  excludedHint: { color: "#64748b", fontSize: 13, lineHeight: 18, maxWidth: 250, flexShrink: 1 },
  itemTeachButton: { minHeight: 46, borderRadius: 11, backgroundColor: "#eff6ff", borderWidth: 1, borderColor: "#93c5fd", alignItems: "center", justifyContent: "center", marginTop: 12, paddingHorizontal: 14 },
  itemTeachButtonText: { color: "#1d4ed8", fontSize: 14, fontWeight: "800" },
  submitButton: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 16,
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  disabledButton: {
    opacity: 0.6,
  },
  submitText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  error: {
    color: "#b91c1c",
    fontSize: 15,
    marginBottom: 12,
  },
  retryButton: {
    borderRadius: 10,
    backgroundColor: "#2563eb",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  retryText: {
    color: "#fff",
    fontWeight: "700",
  },
  empty: {
    textAlign: "center",
    color: "#6b7280",
    marginTop: 24,
  },
});
