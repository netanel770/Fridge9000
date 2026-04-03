import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { getInventory } from "../src/services/api";
import type { InventoryItem } from "../src/types/api";

export default function InventoryScreen() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  async function loadData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    setError("");

    try {
      const data = await getInventory();
      setItems(data);
    } catch (e: any) {
      setError(e.message || "Failed to load inventory");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

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
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => String(item.id)}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} />
      }
      renderItem={({ item }) => (
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.qty}>Qty: {item.quantity}</Text>
          </View>

          <Text style={styles.meta}>Category: {item.category}</Text>
          <Text style={styles.meta}>Status: {item.status}</Text>
          <Text style={styles.meta}>
            Updated: {new Date(item.last_updated).toLocaleString()}
          </Text>
        </View>
      )}
      ListEmptyComponent={<Text style={styles.empty}>No inventory items found</Text>}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 8,
  },
  name: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  qty: {
    fontSize: 16,
    fontWeight: "600",
    color: "#2563eb",
  },
  meta: {
    fontSize: 14,
    color: "#4b5563",
    marginTop: 4,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  error: {
    color: "#b91c1c",
    fontSize: 15,
  },
  empty: {
    textAlign: "center",
    marginTop: 30,
    color: "#6b7280",
  },
});