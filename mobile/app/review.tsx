import { useEffect, useState } from "react";
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
} from "react-native";

import { router, useLocalSearchParams } from "expo-router";

import {
  getLatestScan,
  getScanDetections,
  getInventoryBatches,
  submitReview,
} from "../src/services/api";

import { API_BASE_URL } from "../src/services/config";

import type { InventoryBatchItem, ReviewItem } from "../src/types/api";

function normalizeItemName(value: string) {
  return value.trim().toLowerCase();
}

function getBatchExpiryDate(batch: InventoryBatchItem) {
  return batch.expiry_date || batch.expiry_estimate_date || null;
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
  const { mode } = useLocalSearchParams<{
    mode?: "Added" | "Removed";
  }>();

  const [scanId, setScanId] = useState<number | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [inventoryBatches, setInventoryBatches] = useState<InventoryBatchItem[]>([]);
  const [openExpiryPicker, setOpenExpiryPicker] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function loadData() {
    setLoading(true);
    setError("");

    try {
      const latestScan = await getLatestScan();

      if (!latestScan?.id) {
        setError("No scan found");
        return;
      }

      setScanId(latestScan.id);

      const [detections, batches] = await Promise.all([
        getScanDetections(latestScan.id),
        mode === "Removed" ? getInventoryBatches() : Promise.resolve([]),
      ]);

      setInventoryBatches(batches);

      const reviewItems: ReviewItem[] = detections.map((d) => {
        const suggestedExpiry = mode === "Removed" ? null : getSuggestedExpiryDate(d.label);
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
          expiry_date: suggestedExpiry,
          expiry_estimate_date: suggestedExpiry,
          expiry_source: mode === "Removed" ? null : "estimated",
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
    const quantities = new Map<string, number>();
    const itemName = normalizeItemName(item.final_label || item.original_label);

    inventoryBatches.forEach((batch) => {
      const expiryDate = getBatchExpiryDate(batch);
      if (normalizeItemName(batch.name) === itemName && expiryDate) {
        quantities.set(expiryDate, (quantities.get(expiryDate) || 0) + batch.quantity);
      }
    });

    return [...quantities.entries()]
      .map(([date, quantity]) => ({ date, quantity }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  function selectRemovalExpiry(index: number, expiryDate: string) {
    const item = items[index];
    const itemName = normalizeItemName(item.final_label || item.original_label);
    const available = getExpiryOptions(item).find((option) => option.date === expiryDate)?.quantity || 0;
    const alreadySelected = items.filter((candidate, candidateIndex) =>
      candidateIndex !== index &&
      candidate.included &&
      normalizeItemName(candidate.final_label || candidate.original_label) === itemName &&
      candidate.expiry_date === expiryDate
    ).length;

    if (alreadySelected >= available) {
      Alert.alert(
        "Expiry date unavailable",
        `Only ${available} ${item.final_label || item.original_label} item(s) with expiry date ${expiryDate} are in inventory.`,
      );
      return;
    }

    setItems((previous) => previous.map((candidate, candidateIndex) =>
      candidateIndex === index
        ? {
            ...candidate,
            expiry_date: expiryDate,
            expiry_estimate_date: null,
            expiry_source: "inventory",
          }
        : candidate
    ));
    setOpenExpiryPicker(null);
  }

  function validateRemovalSelections() {
    const usage = new Map<string, number>();

    for (const item of items) {
      if (!item.included) continue;
      if (!item.expiry_date) {
        Alert.alert(
          "Missing expiry date",
          `Please select an expiry date for ${item.final_label || item.original_label}.`,
        );
        return false;
      }

      const name = normalizeItemName(item.final_label || item.original_label);
      const key = `${name}|${item.expiry_date}`;
      usage.set(key, (usage.get(key) || 0) + 1);
      const available = getExpiryOptions(item).find(
        (option) => option.date === item.expiry_date
      )?.quantity || 0;

      if ((usage.get(key) || 0) > available) {
        Alert.alert(
          "Not enough inventory",
          `Only ${available} ${item.final_label || item.original_label} item(s) with expiry date ${item.expiry_date} are in inventory.`,
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
    value: string | boolean
  ) {
    setItems((prev) => {
      const updated = [...prev];

      updated[index] = {
        ...updated[index],
        [field]: value,
      } as ReviewItem;

      return updated;
    });
  }

  async function handleSubmit() {
    if (!scanId) {
      Alert.alert("Missing scan", "No valid scan found.");
      return;
    }

    if (mode === "Removed" && !validateRemovalSelections()) {
      return;
    }

    setSubmitting(true);

    try {
      await submitReview(scanId, items, mode || "Added");

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
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <FlatList
        data={items}
        keyExtractor={(_, index) => String(index)}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        renderItem={({ item, index }) => (
          <View style={styles.card}>
            {scanId && item.id && item.x1 != null && (
              <View style={styles.imageBox}>
                <Image
                  source={{
                    uri: `${API_BASE_URL}/scans/${scanId}/detections/${item.id}/boxed`,
                  }}
                  style={styles.detectedImage}
                  resizeMode="contain"
                />
              </View>
            )}

            <Text style={styles.label}>Original label</Text>
            <Text style={styles.originalValue}>{item.original_label}</Text>

            <Text style={styles.label}>Confidence</Text>
            <Text style={styles.confidenceText}>{(item.confidence ?? 0).toFixed(2)}</Text>

            <Text style={styles.label}>Final label</Text>
            <TextInput
              value={item.final_label}
              onChangeText={(text) => updateItem(index, "final_label", text)}
              style={[
                styles.input,
                item.included ? styles.disabledInput : styles.enabledInput,
              ]}
              editable={!item.included}
            />

            <Text style={styles.label}>
              {mode === "Removed" ? "Expiry date in inventory" : "Estimated expiry date"}
            </Text>
            {mode === "Removed" ? (
              <View>
                <Pressable
                  style={styles.expirySelect}
                  onPress={() => setOpenExpiryPicker(openExpiryPicker === index ? null : index)}
                >
                  <Text style={item.expiry_date ? styles.expirySelectText : styles.placeholderText}>
                    {item.expiry_date || "Select expiry date"}
                  </Text>
                  <Text style={styles.chevron}>{openExpiryPicker === index ? "-" : "+"}</Text>
                </Pressable>
                {openExpiryPicker === index && (
                  <View style={styles.expiryOptions}>
                    {getExpiryOptions(item).length > 0 ? getExpiryOptions(item).map((option) => (
                      <Pressable
                        key={option.date}
                        style={styles.expiryOption}
                        onPress={() => selectRemovalExpiry(index, option.date)}
                      >
                        <Text style={styles.expiryOptionDate}>{option.date}</Text>
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
              />
            )}

            <View style={styles.switchRow}>
              <Text style={styles.label}>Include</Text>
              <Switch
                value={item.included}
                onValueChange={(value) => updateItem(index, "included", value)}
              />
            </View>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No detections found</Text>}
      />

      <Pressable
        style={[styles.submitButton, submitting && styles.disabledButton]}
        onPress={handleSubmit}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>Submit Review</Text>
        )}
      </Pressable>
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
  card: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e5e7eb",
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
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
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
  },
  expiryOptionDate: {
    color: "#111827",
    fontWeight: "600",
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
