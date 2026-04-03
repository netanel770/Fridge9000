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
} from "react-native";
import { router } from "expo-router";
import { getLatestScan, getScanDetections, submitReview } from "../src/services/api";
import type { ReviewItem } from "../src/types/api";

export default function ReviewScreen() {
  const [scanId, setScanId] = useState<number | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
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

      const detections = await getScanDetections(latestScan.id);

      const reviewItems: ReviewItem[] = detections.map((d) => ({
        original_label: d.label,
        final_label: d.label,
        included: true,
      }));

      setItems(reviewItems);
    } catch (e: any) {
      setError(e.message || "Failed to load detections");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  function updateItem(index: number, field: keyof ReviewItem, value: string | boolean) {
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

    setSubmitting(true);

    try {
      await submitReview(scanId, items);
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
    <View style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(_, index) => String(index)}
        contentContainerStyle={styles.listContent}
        renderItem={({ item, index }) => (
          <View style={styles.card}>
            <Text style={styles.label}>Original label</Text>
            <Text style={styles.originalValue}>{item.original_label}</Text>

            <Text style={styles.label}>Final label</Text>
            <TextInput
              value={item.final_label}
              onChangeText={(text) => updateItem(index, "final_label", text)}
              style={styles.input}
              placeholder="Edit label"
            />

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
    </View>
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
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
    marginBottom: 12,
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
    backgroundColor: "#10b981",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  submitText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  disabledButton: {
    opacity: 0.7,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  error: {
    color: "#b91c1c",
    fontSize: 15,
    marginBottom: 12,
    textAlign: "center",
  },
  retryButton: {
    backgroundColor: "#2563eb",
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  retryText: {
    color: "#fff",
    fontWeight: "700",
  },
  empty: {
    textAlign: "center",
    marginTop: 30,
    color: "#6b7280",
  },
});