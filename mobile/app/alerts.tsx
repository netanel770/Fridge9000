import { useCallback, useMemo, useState } from "react";
import { router, useFocusEffect } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { getAlerts } from "../src/services/api";
import type { AlertItem } from "../src/types/api";
import { EmptyState, ScreenHeader, StatusBadge } from "../src/components/ui";
import { colors, radius, spacing } from "../src/theme";
import { formatAmount } from "../src/utils/number";

type AlertFilter = "all" | "stock" | "expiry";
type AlertGroup = { itemId: number; name: string; category: string; alerts: AlertItem[] };
const FILTERS: { value: AlertFilter; label: string }[] = [
  { value: "all", label: "All" }, { value: "stock", label: "Low stock" }, { value: "expiry", label: "Expiry" },
];

function statusLabel(status: AlertItem["status"]) {
  if (status === "EXPIRING") return "Expiring soon";
  if (status === "EXPIRED") return "Expired";
  if (status === "MISSING") return "Missing";
  return "Low stock";
}

export default function AlertsScreen() {
  const [items, setItems] = useState<AlertItem[]>([]);
  const [filter, setFilter] = useState<AlertFilter>("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const loadData = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true); setError("");
    try { setItems(await getAlerts()); }
    catch (e: any) { setError(e.message || "Could not load alerts."); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const groups = useMemo<AlertGroup[]>(() => {
    const grouped = new Map<number, AlertGroup>();
    items.filter((item) => filter === "all" || item.alert_type === filter).forEach((item) => {
      const current = grouped.get(item.item_id);
      current ? current.alerts.push(item) : grouped.set(item.item_id, { itemId: item.item_id, name: item.name, category: item.category, alerts: [item] });
    });
    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [filter, items]);

  function toggle(itemId: number) {
    setExpanded((current) => { const next = new Set(current); next.has(itemId) ? next.delete(itemId) : next.add(itemId); return next; });
  }

  if (loading) return <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /><Text style={styles.muted}>Checking alerts…</Text></View>;
  return <View style={styles.screen}>
    <View style={styles.header}><ScreenHeader eyebrow="Attention" title="Alerts" subtitle="Grouped by product, with the next action close at hand." /></View>
    <View style={styles.filters}>{FILTERS.map((option) => <Pressable key={option.value} onPress={() => setFilter(option.value)} style={[styles.filter, filter === option.value && styles.activeFilter]}><Text style={[styles.filterText, filter === option.value && styles.activeFilterText]}>{option.label}</Text></Pressable>)}</View>
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <FlatList data={groups} keyExtractor={(group) => String(group.itemId)} contentContainerStyle={styles.list} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} />}
      renderItem={({ item: group }) => {
        const isExpanded = expanded.has(group.itemId);
        const stockCount = group.alerts.filter((alert) => alert.alert_type === "stock").length;
        const expiryCount = group.alerts.filter((alert) => alert.alert_type === "expiry").length;
        const summary = [stockCount ? `${stockCount} stock alert${stockCount === 1 ? "" : "s"}` : "", expiryCount ? `${expiryCount} expiry alert${expiryCount === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
        return <View style={styles.group}>
          <Pressable style={styles.groupHeader} onPress={() => toggle(group.itemId)}><View style={styles.groupCopy}><Text style={styles.name}>{group.name}</Text><Text style={styles.category}>{group.category}</Text><Text style={styles.summary}>{summary}</Text></View><View style={styles.chevron}><Ionicons name={isExpanded ? "chevron-up" : "chevron-down"} size={18} color={colors.primary} /></View></Pressable>
          {isExpanded ? <View style={styles.alertList}>{group.alerts.map((alert) => {
            const tone = alert.status === "EXPIRED" || alert.status === "MISSING" ? "danger" : alert.status === "LOW" ? "warning" : "info";
            const action = alert.status === "EXPIRED" ? "Review expired product" : alert.alert_type === "stock" ? "Update inventory" : "View in inventory";
            return <View key={`${alert.alert_type}-${alert.batch_id || alert.id}`} style={styles.alertRow}>
              <View style={styles.row}><Text style={styles.kind}>{alert.alert_type === "stock" ? "Stock" : "Expiry"}</Text><StatusBadge label={statusLabel(alert.status)} tone={tone} /></View>
              <Text style={styles.meta}>Amount: {formatAmount(alert.quantity)}</Text>{alert.expiry_date ? <Text style={styles.meta}>Expires: {alert.expiry_date}</Text> : null}
              <Pressable style={styles.action} onPress={() => router.push(alert.status === "EXPIRED" ? "/expired-items" : alert.alert_type === "stock" ? "/update-inventory" : "/inventory")}><Text style={styles.actionText}>{action}</Text><Ionicons name="arrow-forward" size={16} color={colors.primary} /></Pressable>
            </View>;
          })}</View> : null}
        </View>;
      }}
      ListEmptyComponent={<EmptyState title="Everything looks good" message="There are no active stock or expiry alerts." />}
    />
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, header: { padding: spacing.lg, paddingBottom: spacing.sm }, filters: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  filter: { flex: 1, paddingVertical: 10, alignItems: "center", borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }, activeFilter: { backgroundColor: colors.primary, borderColor: colors.primary }, filterText: { color: colors.textSecondary, fontWeight: "700", fontSize: 13 }, activeFilterText: { color: colors.primaryText },
  list: { padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.md, paddingBottom: 44 }, group: { backgroundColor: colors.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }, groupHeader: { padding: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md }, groupCopy: { flex: 1 }, name: { fontSize: 18, fontWeight: "800", color: colors.navy }, category: { color: colors.textMuted, marginTop: 3 }, summary: { color: colors.primary, fontWeight: "700", marginTop: 6, fontSize: 13 }, chevron: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  alertList: { borderTopWidth: 1, borderTopColor: colors.border, padding: spacing.md, gap: spacing.sm }, alertRow: { backgroundColor: colors.background, borderRadius: radius.lg, padding: spacing.md }, row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm }, kind: { fontWeight: "800", color: colors.textSecondary }, meta: { color: colors.textSecondary, marginTop: 6, fontSize: 14 }, action: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 5, marginTop: spacing.md, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border }, actionText: { color: colors.primary, fontWeight: "800", fontSize: 13 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md }, muted: { color: colors.textMuted }, error: { color: colors.danger, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
});
