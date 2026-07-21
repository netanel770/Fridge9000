import { useCallback, useMemo, useState } from "react";
import { useFocusEffect } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  getInventoryBatches,
  removeInventoryBatch,
  updateInventoryBatchExpiry,
} from "../src/services/api";
import type { InventoryBatchItem } from "../src/types/api";

function effectiveExpiry(batch: InventoryBatchItem) {
  return batch.expiry_date || batch.expiry_estimate_date || null;
}

function localToday() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidFutureDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  const isRealDate = parsed.getFullYear() === Number(year)
    && parsed.getMonth() === Number(month) - 1
    && parsed.getDate() === Number(day);
  return isRealDate && value > localToday();
}

export default function ExpiredItemsScreen() {
  const [batches, setBatches] = useState<InventoryBatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyBatchId, setBusyBatchId] = useState<number | null>(null);
  const [editingBatchId, setEditingBatchId] = useState<number | null>(null);
  const [newExpiryDate, setNewExpiryDate] = useState("");

  const expiredBatches = useMemo(
    () => batches
      .filter((batch) => {
        const expiry = effectiveExpiry(batch);
        return batch.quantity > 0 && expiry !== null && expiry <= localToday();
      })
      .sort((a, b) => (effectiveExpiry(a) || "").localeCompare(effectiveExpiry(b) || "")),
    [batches],
  );

  async function loadData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      setBatches(await getInventoryBatches());
    } catch (e: any) {
      Alert.alert("Load failed", e.message || "Could not load expired products.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useFocusEffect(useCallback(() => {
    loadData();
  }, []));

  function confirmRemove(batch: InventoryBatchItem) {
    Alert.alert(
      "Remove expired products?",
      `Remove ${batch.quantity} ${batch.name} item(s) expiring on ${effectiveExpiry(batch)}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setBusyBatchId(batch.id);
            try {
              await removeInventoryBatch(batch.id);
              setBatches((previous) => previous.filter((item) => item.id !== batch.id));
            } catch (e: any) {
              Alert.alert("Remove failed", e.message || "Could not remove this batch.");
            } finally {
              setBusyBatchId(null);
            }
          },
        },
      ],
    );
  }

  async function saveExpiry(batch: InventoryBatchItem) {
    if (!isValidFutureDate(newExpiryDate)) {
      Alert.alert("Invalid date", "Enter a real future date in YYYY-MM-DD format.");
      return;
    }

    setBusyBatchId(batch.id);
    try {
      await updateInventoryBatchExpiry(batch.id, newExpiryDate);
      setBatches((previous) => previous.map((item) => item.id === batch.id
        ? { ...item, expiry_date: newExpiryDate, expiry_estimate_date: null, expiry_source: "manual" }
        : item));
      setEditingBatchId(null);
      setNewExpiryDate("");
    } catch (e: any) {
      Alert.alert("Update failed", e.message || "Could not update the expiry date.");
    } finally {
      setBusyBatchId(null);
    }
  }

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" /></View>;
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <FlatList
        data={expiredBatches}
        keyExtractor={(batch) => String(batch.id)}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} />}
        ListHeaderComponent={(
          <View style={styles.header}>
            <Text style={styles.title}>Expired Products</Text>
            <Text style={styles.subtitle}>
              Remove spoiled products, or set a new date when an estimated expiry was too early.
            </Text>
          </View>
        )}
        renderItem={({ item }) => {
          const editing = editingBatchId === item.id;
          const busy = busyBatchId === item.id;
          return (
            <View style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.quantity}>Qty: {item.quantity}</Text>
              </View>
              <Text style={styles.meta}>Category: {item.category}</Text>
              <Text style={styles.expiredDate}>Expired: {effectiveExpiry(item)}</Text>
              <Text style={styles.meta}>
                Date source: {item.expiry_source === "manual" ? "Manual" : "Estimated"}
              </Text>

              {editing ? (
                <View style={styles.editor}>
                  <Text style={styles.label}>New expiry date</Text>
                  <TextInput
                    value={newExpiryDate}
                    onChangeText={setNewExpiryDate}
                    placeholder="YYYY-MM-DD"
                    style={styles.input}
                    autoCapitalize="none"
                    keyboardType="numbers-and-punctuation"
                  />
                  <View style={styles.actions}>
                    <Pressable
                      style={[styles.actionButton, styles.cancelButton]}
                      onPress={() => { setEditingBatchId(null); setNewExpiryDate(""); }}
                      disabled={busy}
                    >
                      <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.actionButton, styles.saveButton, busy && styles.disabled]}
                      onPress={() => saveExpiry(item)}
                      disabled={busy}
                    >
                      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Save date</Text>}
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={styles.actions}>
                  <Pressable
                    style={[styles.actionButton, styles.removeButton, busy && styles.disabled]}
                    onPress={() => confirmRemove(item)}
                    disabled={busy}
                  >
                    {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Remove</Text>}
                  </Pressable>
                  <Pressable
                    style={[styles.actionButton, styles.updateButton]}
                    onPress={() => { setEditingBatchId(item.id); setNewExpiryDate(""); }}
                    disabled={busy}
                  >
                    <Text style={styles.updateText}>Update date</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>There are no expired products.</Text>}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f8fafc" },
  container: { padding: 16, gap: 12, paddingBottom: 40 },
  header: { marginBottom: 4 },
  title: { fontSize: 26, fontWeight: "700", color: "#111827" },
  subtitle: { color: "#6b7280", marginTop: 6, lineHeight: 20 },
  card: { backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#fecaca", padding: 16 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  name: { fontSize: 18, fontWeight: "700", color: "#111827", flex: 1 },
  quantity: { color: "#2563eb", fontWeight: "700" },
  meta: { color: "#6b7280", marginTop: 5 },
  expiredDate: { color: "#b91c1c", fontWeight: "700", marginTop: 8 },
  actions: { flexDirection: "row", gap: 10, marginTop: 16 },
  actionButton: { flex: 1, minHeight: 44, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  removeButton: { backgroundColor: "#dc2626" },
  updateButton: { backgroundColor: "#eff6ff", borderWidth: 1, borderColor: "#93c5fd" },
  updateText: { color: "#1d4ed8", fontWeight: "700" },
  buttonText: { color: "#fff", fontWeight: "700" },
  editor: { marginTop: 14 },
  label: { color: "#374151", fontWeight: "700", marginBottom: 6 },
  input: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#d1d5db", borderRadius: 10, paddingHorizontal: 12, height: 48 },
  cancelButton: { backgroundColor: "#f3f4f6" },
  cancelText: { color: "#374151", fontWeight: "700" },
  saveButton: { backgroundColor: "#2563eb" },
  disabled: { opacity: 0.6 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { textAlign: "center", color: "#6b7280", marginTop: 30 },
});
