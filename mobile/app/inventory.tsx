import { useCallback, useMemo, useState } from "react";
import { router, useFocusEffect } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { getInventory, getInventoryBatches } from "../src/services/api";
import type { InventoryBatchItem, InventoryItem } from "../src/types/api";
import { EmptyState, ScreenHeader, StatusBadge } from "../src/components/ui";
import { colors, radius, spacing } from "../src/theme";
import { formatAmount } from "../src/utils/number";

type SortMode = "name" | "expiry" | "quantity";
function expiryOf(batch: InventoryBatchItem) { return batch.expiry_date || batch.expiry_estimate_date || null; }

export default function InventoryScreen() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [batches, setBatches] = useState<InventoryBatchItem[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("name");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const loadData = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true); setError("");
    try { const [nextItems, nextBatches] = await Promise.all([getInventory(), getInventoryBatches()]); setItems(nextItems); setBatches(nextBatches); }
    catch (e: any) { setError(e.message || "Could not load inventory."); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const visibleItems = useMemo(() => {
    const next = items.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()));
    return next.sort((a, b) => {
      if (sort === "quantity") return a.quantity - b.quantity;
      if (sort === "expiry") return (a.expiry_date || "9999").localeCompare(b.expiry_date || "9999");
      return a.name.localeCompare(b.name);
    });
  }, [items, search, sort]);

  if (loading) return <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /><Text style={styles.muted}>Loading products…</Text></View>;

  return <View style={styles.screen}>
    <FlatList data={visibleItems} keyExtractor={(item) => String(item.id)} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} />} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets
      ListHeaderComponent={<View style={styles.header}>
        <ScreenHeader eyebrow="Inventory" title="Products and batches" subtitle={`${items.length} product labels currently tracked`} />
        <View style={styles.searchBox}><Ionicons name="search" size={20} color={colors.textMuted} /><TextInput value={search} onChangeText={setSearch} placeholder="Search products" placeholderTextColor={colors.textMuted} style={styles.searchInput} /></View>
        <View style={styles.filters}>{(["name", "expiry", "quantity"] as SortMode[]).map((value) => <Pressable key={value} onPress={() => setSort(value)} style={[styles.filter, sort === value && styles.activeFilter]}><Text style={[styles.filterText, sort === value && styles.activeFilterText]}>{value === "name" ? "Name" : value === "expiry" ? "Expiry" : "Lowest stock"}</Text></Pressable>)}</View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>}
      renderItem={({ item }) => {
        const itemBatches = batches.filter((batch) => batch.item_id === item.id && batch.quantity > 0);
        const open = itemBatches.filter((batch) => batch.open_unit_remaining_percent != null);
        const isExpanded = expanded === item.id;
        const tone = item.status === "MISSING" ? "danger" : item.status === "LOW" ? "warning" : "success";
        return <View style={styles.card}>
          <Pressable onPress={() => setExpanded(isExpanded ? null : item.id)}>
            <View style={styles.cardTop}><View style={styles.productIcon}><Ionicons name="cube-outline" size={25} color={colors.primary} /></View><View style={styles.cardCopy}><Text style={styles.name}>{item.name}</Text><Text style={styles.category}>{item.category}</Text></View><StatusBadge label={item.status === "OK" ? "In stock" : item.status === "LOW" ? "Low stock" : "Missing"} tone={tone} /></View>
            <View style={styles.metrics}><Metric value={formatAmount(item.quantity)} label="products" /><Metric value={formatAmount(item.estimated_quantity ?? item.quantity)} label="amount" /><Metric value={`${open.length}`} label="open" /></View>
            <View style={styles.expiryRow}><Ionicons name="calendar-outline" size={17} color={colors.textMuted} /><Text style={styles.expiry}>{item.expiry_date ? `Next expiry: ${item.expiry_date}` : "No expiry date"}</Text><Ionicons name={isExpanded ? "chevron-up" : "chevron-down"} size={19} color={colors.primary} /></View>
          </Pressable>
          {isExpanded ? <View style={styles.batchArea}>{itemBatches.length ? itemBatches.map((batch) => {
            const percent = batch.open_unit_remaining_percent;
            const sealed = percent == null ? batch.quantity : Math.max(0, batch.quantity - 1);
            return <View key={batch.id} style={styles.batch}><View style={styles.batchTop}><Text style={styles.batchTitle}>{expiryOf(batch) || "No expiry date"}</Text><StatusBadge label={batch.expiry_source === "manual" ? "Confirmed date" : "Estimated date"} tone="neutral" /></View><Text style={styles.batchText}>{percent == null ? `${batch.quantity} sealed unit${batch.quantity === 1 ? "" : "s"}` : `${sealed} sealed + 1 open at ${percent}%`}</Text></View>;
          }) : <Text style={styles.muted}>No active batches recorded.</Text>}<Pressable style={styles.adjustLink} onPress={() => router.push({ pathname: "/adjust-open-product", params: { itemId: String(item.id), itemName: item.name } })}><Ionicons name="options-outline" size={18} color={colors.primary} /><Text style={styles.adjustText}>Adjust open amount</Text></Pressable></View> : null}
        </View>;
      }}
      ListEmptyComponent={<EmptyState icon="file-tray-outline" title={search ? "No matching products" : "Your inventory is empty"} message={search ? "Try a different product name." : "Scan products to start tracking your fridge."} action={!search ? "Update inventory" : undefined} onAction={() => router.push("/update-inventory")} />}
    />
  </View>;
}

function Metric({ value, label }: { value: string; label: string }) { return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>; }
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, list: { padding: spacing.lg, gap: spacing.md, paddingBottom: 44 }, header: { gap: spacing.md, marginBottom: spacing.xs },
  searchBox: { height: 48, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, gap: spacing.sm }, searchInput: { flex: 1, color: colors.textPrimary, fontSize: 15 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }, filter: { minHeight: 40, justifyContent: "center", paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }, activeFilter: { backgroundColor: colors.primary, borderColor: colors.primary }, filterText: { color: colors.textSecondary, fontWeight: "700", fontSize: 13 }, activeFilterText: { color: colors.primaryText },
  card: { backgroundColor: colors.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, shadowColor: colors.navy, shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 1 }, cardTop: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md }, productIcon: { width: 48, height: 48, borderRadius: 15, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" }, cardCopy: { flex: 1, minWidth: 0 }, name: { fontSize: 18, fontWeight: "800", color: colors.navy, flexShrink: 1 }, category: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  metrics: { flexDirection: "row", marginTop: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted, padding: spacing.md }, metric: { flex: 1, alignItems: "center", minWidth: 0 }, metricValue: { color: colors.navy, fontWeight: "800", fontSize: 17 }, metricLabel: { color: colors.textMuted, fontSize: 13, marginTop: 2, textAlign: "center" }, expiryRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md }, expiry: { flex: 1, color: colors.textSecondary, fontSize: 13 },
  batchArea: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.md, paddingTop: spacing.md, gap: spacing.sm }, batch: { padding: spacing.md, backgroundColor: colors.background, borderRadius: radius.lg }, batchTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm }, batchTitle: { fontWeight: "800", color: colors.navy, fontSize: 13 }, batchText: { color: colors.textSecondary, marginTop: 6, fontSize: 13 }, adjustLink: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingTop: spacing.sm }, adjustText: { color: colors.primary, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md }, muted: { color: colors.textMuted }, error: { color: colors.danger },
});
