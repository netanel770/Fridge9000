import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Pressable,
} from "react-native";
import { getEvents } from "../src/services/api";
import type { EventItem } from "../src/types/api";
import { formatIsraelTime } from "../src/utils/date";

export default function EventsScreen() {
  const [items, setItems] = useState<EventItem[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  async function loadData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    setError("");

    try {
      const data = await getEvents(50);
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

  const groupedScans = useMemo(() => {
    const groups: Record<string, EventItem[]> = {};

    items.forEach((event) => {
      const key = event.scan_id ? `scan-${event.scan_id}` : `manual-${event.id}`;

      if (!groups[key]) {
        groups[key] = [];
      }

      groups[key].push(event);
    });

    return Object.entries(groups).map(([key, events]) => ({
      key,
      scanId: events[0].scan_id,
      createdAt: events[0].created_at,
      events,
    }));
  }, [items]);

  function toggleGroup(key: string) {
    setExpanded((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
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
      </View>
    );
  }

  return (
    <FlatList
      data={groupedScans}
      keyExtractor={(group) => group.key}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} />
      }
      renderItem={({ item }) => {
        const isOpen = expanded[item.key];

        return (
          <View style={styles.scanCard}>
            <Pressable style={styles.scanHeader} onPress={() => toggleGroup(item.key)}>
              <View>
                <Text style={styles.scanTitle}>
                  {item.scanId ? `Scan #${item.scanId}` : "Manual Update"}
                </Text>

                <Text style={styles.scanMeta}>
                  {formatIsraelTime(item.createdAt)}
                </Text>

                <Text style={styles.scanMeta}>
                  {item.events.length} item events
                </Text>
              </View>

              <Text style={styles.arrow}>{isOpen ? "▲" : "▼"}</Text>
            </Pressable>

            {isOpen &&
              item.events.map((event) => (
                <View key={String(event.id)} style={styles.eventRow}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.itemName}>{event.item_name}</Text>

                    <Text
                      style={[
                        styles.actionBadge,
                        event.action === "Added" ? styles.added : styles.removed,
                      ]}
                    >
                      {event.action}
                    </Text>
                  </View>

                  <Text style={styles.meta}>Confidence: {event.confidence}</Text>
                  <Text style={styles.meta}>Quantity: {event.quantity_change}</Text>
                  <Text style={styles.meta}>
                    Time: {formatIsraelTime(event.created_at)}
                  </Text>
                </View>
              ))}
          </View>
        );
      }}
      ListEmptyComponent={<Text style={styles.empty}>No events found</Text>}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
  },
  scanCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    overflow: "hidden",
  },
  scanHeader: {
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  scanTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  scanMeta: {
    fontSize: 14,
    color: "#6b7280",
    marginTop: 4,
  },
  arrow: {
    fontSize: 20,
    fontWeight: "700",
    color: "#374151",
  },
  eventRow: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  itemName: {
    fontSize: 16,
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