import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { getEvents } from "../src/services/api";
import type { EventItem } from "../src/types/api";

export default function EventsScreen() {
  const [items, setItems] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  async function loadData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    setError("");

    try {
      const data = await getEvents(20);
      setItems(data);
    } catch (e: any) {
      setError(e.message || "Failed to load events");
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
            <Text style={styles.itemName}>{item.item_name}</Text>
            <Text
              style={[
                styles.actionBadge,
                item.action === "Added" ? styles.added : styles.removed,
              ]}
            >
              {item.action}
            </Text>
          </View>

          <Text style={styles.meta}>Confidence: {item.confidence}</Text>
          <Text style={styles.meta}>
            Time: {new Date(item.created_at).toLocaleString()}
          </Text>
        </View>
      )}
      ListEmptyComponent={<Text style={styles.empty}>No events found</Text>}
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
  itemName: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  actionBadge: {
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: "hidden",
  },
  added: {
    backgroundColor: "#dcfce7",
    color: "#15803d",
  },
  removed: {
    backgroundColor: "#fee2e2",
    color: "#b91c1c",
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