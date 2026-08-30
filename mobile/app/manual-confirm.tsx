import { router, useLocalSearchParams } from "expo-router";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useState } from "react";
import { manualInventoryUpdate } from "../src/services/api";
import { showMessage } from "../src/utils/confirm";

export default function ManualConfirmScreen() {
  const params = useLocalSearchParams<{
    itemName?: string;
    mode?: "Added" | "Removed";
    quantityChange?: string;
    beforeQty?: string;
    afterQty?: string;
    expiryDate?: string;
    expirySource?: "manual" | "estimated";
  }>();

  const [loading, setLoading] = useState(false);

  const itemName = params.itemName || "";
  const mode = params.mode || "Added";
  const quantityChange = Number(params.quantityChange || 1);
  const beforeQty = Number(params.beforeQty || 0);
  const afterQty = Number(params.afterQty || 0);
  const expiryDate = params.expiryDate || "";
  const expirySource = params.expirySource || "manual";

  async function confirmAction() {
    setLoading(true);

    try {
      await manualInventoryUpdate(itemName, mode, quantityChange, expiryDate, expirySource);

      await showMessage("Success", "Inventory updated successfully.");
      router.replace("/inventory");
    } catch (e: any) {
      Alert.alert("Update failed", e.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Confirm Update</Text>
      <Text style={styles.subtitle}>Please review the inventory change</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Item</Text>
        <Text style={styles.value}>{itemName}</Text>

        <Text style={styles.label}>Action</Text>
        <Text style={styles.value}>{mode === "Added" ? "Add" : "Remove"}</Text>

        <Text style={styles.label}>Quantity change</Text>
        <Text style={styles.value}>{quantityChange}</Text>

        <Text style={styles.label}>Expiry date</Text>
        <Text style={styles.value}>{expiryDate === "__NO_EXPIRY__" ? "No expiry date" : expiryDate}</Text>
        {mode === "Added" && (
          <Text style={styles.dateSource}>
            {expirySource === "estimated" ? "Suggested date" : "Manually selected date"}
          </Text>
        )}

        <View style={styles.qtyCompare}>
          <View style={styles.qtyBox}>
            <Text style={styles.qtyLabel}>Before</Text>
            <Text style={styles.qtyNumber}>{beforeQty}</Text>
          </View>

          <Text style={styles.arrow}>{"->"}</Text>

          <View style={styles.qtyBox}>
            <Text style={styles.qtyLabel}>After</Text>
            <Text style={styles.qtyNumber}>{afterQty}</Text>
          </View>
        </View>
      </View>

      <Pressable
        style={[styles.confirmButton, loading && styles.disabledButton]}
        onPress={confirmAction}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.confirmText}>Confirm</Text>
        )}
      </Pressable>

      <Pressable style={styles.backButton} onPress={() => router.back()}>
        <Text style={styles.backText}>Go Back</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    gap: 16,
    backgroundColor: "#f8fafc",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#111827",
  },
  subtitle: {
    fontSize: 15,
    color: "#6b7280",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: "700",
    color: "#6b7280",
    marginTop: 8,
  },
  value: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  dateSource: {
    color: "#6b7280",
    fontSize: 13,
  },
  qtyCompare: {
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  qtyBox: {
    flex: 1,
    backgroundColor: "#f3f4f6",
    borderRadius: 14,
    padding: 16,
    alignItems: "center",
  },
  qtyLabel: {
    color: "#6b7280",
    fontWeight: "700",
    marginBottom: 6,
  },
  qtyNumber: {
    fontSize: 28,
    fontWeight: "800",
    color: "#111827",
  },
  arrow: {
    fontSize: 28,
    fontWeight: "700",
    color: "#6b7280",
    marginHorizontal: 12,
  },
  confirmButton: {
    marginTop: "auto",
    backgroundColor: "#10b981",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  confirmText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  backButton: {
    backgroundColor: "#e5e7eb",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  backText: {
    color: "#111827",
    fontSize: 16,
    fontWeight: "700",
  },
  disabledButton: {
    opacity: 0.7,
  },
});
