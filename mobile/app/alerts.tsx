import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { getAlerts } from "../src/services/api";
import type { AlertItem } from "../src/types/api";

export default function AlertsScreen() {
  const [items, setItems] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  async function loadData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    setError("");

    try {
      const data = await getAlerts();
      setItems(data);
    } catch (e: any) {
      setError(e.message || "Failed to load alerts");
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
            <Text
              style={[
                styles.status,
                item.status === "MISSING" ? styles.missing : styles.low,
              ]}
            >
              {item.status}
            </Text>
          </View>

          <Text style={styles.meta}>Category: {item.category}</Text>
          <Text style={styles.meta}>Quantity: {item.quantity}</Text>
        </View>
      )}
      ListEmptyComponent={<Text style={styles.empty}>No active alerts 🎉</Text>}
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
    alignItems: "center",
  },
  name: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  status: {
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: "hidden",
  },
  missing: {
    backgroundColor: "#fee2e2",
    color: "#b91c1c",
  },
  low: {
    backgroundColor: "#fef3c7",
    color: "#b45309",
  },
  meta: {
    fontSize: 14,
    color: "#4b5563",
    marginTop: 6,
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