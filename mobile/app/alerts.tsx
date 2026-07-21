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
import { getAlerts } from "../src/services/api";
import type { AlertItem } from "../src/types/api";

type AlertFilter = "all" | "stock" | "expiry";

type AlertGroup = {
  itemId: number;
  name: string;
  category: string;
  alerts: AlertItem[];
};

const FILTERS: { value: AlertFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "stock", label: "Low stock" },
  { value: "expiry", label: "Expiry" },
];

function getStatusLabel(status: AlertItem["status"]) {
  if (status === "EXPIRING") return "Expiring soon";
  if (status === "EXPIRED") return "Expired";
  if (status === "MISSING") return "Missing";
  return "Low stock";
}

export default function AlertsScreen() {
  const [items, setItems] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<AlertFilter>("all");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  async function loadData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError("");

    try {
      setItems(await getAlerts());
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

  const groups = useMemo<AlertGroup[]>(() => {
    const filtered = filter === "all"
      ? items
      : items.filter((item) => item.alert_type === filter);
    const grouped = new Map<number, AlertGroup>();

    filtered.forEach((item) => {
      const existing = grouped.get(item.item_id);
      if (existing) existing.alerts.push(item);
      else grouped.set(item.item_id, {
        itemId: item.item_id,
        name: item.name,
        category: item.category,
        alerts: [item],
      });
    });

    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [filter, items]);

  function toggleGroup(itemId: number) {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" /></View>;
  }

  if (error) {
    return <View style={styles.center}><Text style={styles.error}>{error}</Text></View>;
  }

  return (
    <View style={styles.screen}>
      <View style={styles.filterBar}>
        {FILTERS.map((option) => (
          <Pressable
            key={option.value}
            style={[styles.filterButton, filter === option.value && styles.filterButtonActive]}
            onPress={() => setFilter(option.value)}
          >
            <Text style={[styles.filterText, filter === option.value && styles.filterTextActive]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={groups}
        keyExtractor={(group) => String(group.itemId)}
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} />}
        renderItem={({ item: group }) => {
          const expanded = expandedIds.has(group.itemId);
          const stockCount = group.alerts.filter((alert) => alert.alert_type === "stock").length;
          const expiryCount = group.alerts.filter((alert) => alert.alert_type === "expiry").length;

          return (
            <View style={styles.groupCard}>
              <Pressable style={styles.groupHeader} onPress={() => toggleGroup(group.itemId)}>
                <View style={styles.groupTitleArea}>
                  <Text style={styles.name}>{group.name}</Text>
                  <Text style={styles.category}>{group.category}</Text>
                  <Text style={styles.summary}>
                    {stockCount ? `${stockCount} stock alert${stockCount > 1 ? "s" : ""}` : ""}
                    {stockCount && expiryCount ? " · " : ""}
                    {expiryCount ? `${expiryCount} expiry alert${expiryCount > 1 ? "s" : ""}` : ""}
                  </Text>
                </View>
                <Text style={styles.chevron}>{expanded ? "-" : "+"}</Text>
              </Pressable>

              {expanded && (
                <View style={styles.alertList}>
                  {group.alerts.map((alert) => (
                    <View
                      key={`${alert.alert_type}-${alert.batch_id || alert.id}`}
                      style={styles.alertRow}
                    >
                      <View style={styles.rowBetween}>
                        <Text style={styles.alertKind}>
                          {alert.alert_type === "stock" ? "Stock" : "Expiry"}
                        </Text>
                        <Text style={[
                          styles.status,
                          alert.status === "MISSING"
                            ? styles.missing
                            : alert.status === "LOW"
                              ? styles.low
                              : alert.status === "EXPIRED"
                                ? styles.expired
                                : styles.expiring,
                        ]}>
                          {getStatusLabel(alert.status)}
                        </Text>
                      </View>
                      <Text style={styles.meta}>Quantity: {alert.quantity}</Text>
                      {alert.expiry_date && <Text style={styles.meta}>Expires: {alert.expiry_date}</Text>}
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No active alerts</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f8fafc" },
  filterBar: { flexDirection: "row", gap: 8, padding: 16, paddingBottom: 4 },
  filterButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 10,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d1d5db",
  },
  filterButtonActive: { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  filterText: { color: "#374151", fontWeight: "700", fontSize: 13 },
  filterTextActive: { color: "#fff" },
  container: { padding: 16, gap: 12, paddingTop: 12 },
  groupCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    overflow: "hidden",
  },
  groupHeader: {
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  groupTitleArea: { flex: 1 },
  name: { fontSize: 18, fontWeight: "700", color: "#111827" },
  category: { color: "#6b7280", marginTop: 3 },
  summary: { color: "#2563eb", fontWeight: "600", marginTop: 6, fontSize: 13 },
  chevron: { color: "#6b7280", fontSize: 13 },
  alertList: { borderTopWidth: 1, borderTopColor: "#e5e7eb", padding: 12, gap: 8 },
  alertRow: { backgroundColor: "#f8fafc", borderRadius: 10, padding: 12 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  alertKind: { fontWeight: "700", color: "#374151" },
  status: {
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden",
  },
  missing: { backgroundColor: "#fee2e2", color: "#b91c1c" },
  low: { backgroundColor: "#fef3c7", color: "#b45309" },
  expiring: { backgroundColor: "#dbeafe", color: "#1d4ed8" },
  expired: { backgroundColor: "#fee2e2", color: "#b91c1c" },
  meta: { fontSize: 14, color: "#4b5563", marginTop: 6 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  error: { color: "#b91c1c", fontSize: 15, textAlign: "center" },
  empty: { textAlign: "center", marginTop: 30, color: "#6b7280" },
});
