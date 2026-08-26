import { useCallback, useMemo, useRef, useState } from "react";
import { router, useFocusEffect } from "expo-router";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { getAlerts, getInventory, getInventoryBatches } from "../src/services/api";
import type { AlertItem, InventoryBatchItem, InventoryItem } from "../src/types/api";
import { AppButton, Card, EmptyState, ScreenHeader, SectionTitle, StatusBadge } from "../src/components/ui";
import { colors, radius, spacing, typography } from "../src/theme";
import { formatAmount } from "../src/utils/number";

type Suggestion = {
  key: string;
  title: string;
  message: string;
  tone: "danger" | "warning" | "info";
  label: string;
  action: string;
  route: () => void;
};

function withRequestTimeout<T>(request: Promise<T>, controller: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Request timed out"));
    }, 9000);
    request.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}

function suggestionFromAlert(alert: AlertItem): Suggestion {
  const expired = alert.status === "EXPIRED";
  const expiry = alert.alert_type === "expiry";
  return {
    key: `alert-${alert.alert_type}-${alert.batch_id || alert.item_id}-${alert.status}-${alert.quantity}-${alert.expiry_date || "none"}-${alert.last_updated}`,
    title: expired ? `${alert.name} has expired` : expiry ? `${alert.name} expires soon` : `${alert.name} is running low`,
    message: expiry
      ? `${formatAmount(alert.quantity)} product${Number(alert.quantity) === 1 ? "" : "s"}${alert.expiry_date ? ` · ${alert.expiry_date}` : ""}`
      : `${formatAmount(alert.quantity)} amount remaining`,
    tone: expired ? "danger" : "warning",
    label: expired ? "Expired" : expiry ? "Expiring soon" : "Low stock",
    action: expired ? "Review" : expiry ? "View alert" : "Update",
    route: () => router.push(expired ? "/expired-items" : expiry ? "/alerts" : "/update-inventory"),
  };
}

function openSuggestion(batch: InventoryBatchItem): Suggestion {
  return {
    key: `open-${batch.id}-${batch.open_unit_remaining_percent}-${batch.last_updated}`,
    title: `Check open ${batch.name}`,
    message: `${batch.open_unit_remaining_percent}% remaining · last updated ${new Date(batch.last_updated).toLocaleDateString("en-GB")}`,
    tone: "info",
    label: "Open product",
    action: "Adjust",
    route: () => router.push({ pathname: "/adjust-open-product", params: { itemId: String(batch.item_id), itemName: batch.name } }),
  };
}

export default function HomeScreen() {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [batches, setBatches] = useState<InventoryBatchItem[]>([]);
  const [hiddenUntil, setHiddenUntil] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const loadedOnceRef = useRef(false);

  const loadData = useCallback(async (manualRefresh = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;

    if (!loadedOnceRef.current) setLoading(true);
    if (manualRefresh) setRefreshing(true);
    setNotice("");

    const results = await Promise.allSettled([
      withRequestTimeout(getInventory(controller.signal), controller),
      withRequestTimeout(getAlerts(controller.signal), controller),
      withRequestTimeout(getInventoryBatches(controller.signal), controller),
    ]);
    if (requestRef.current !== controller) return;

    const [inventoryResult, alertsResult, batchesResult] = results;
    if (inventoryResult.status === "fulfilled") setInventory(inventoryResult.value);
    if (alertsResult.status === "fulfilled") setAlerts(alertsResult.value);
    if (batchesResult.status === "fulfilled") setBatches(batchesResult.value);

    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed) setNotice(failed === results.length ? "The fridge is taking too long to respond." : "Some fridge details could not be refreshed.");

    loadedOnceRef.current = true;
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => {
    loadData();
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [loadData]));

  const suggestions = useMemo(() => {
    const now = Date.now();
    const staleOpen = batches
      .filter((batch) => batch.quantity > 0 && batch.open_unit_remaining_percent != null && now - new Date(batch.last_updated).getTime() > 3 * 86400000)
      .map(openSuggestion);
    const rank = { danger: 0, warning: 1, info: 2 };
    return [...alerts.map(suggestionFromAlert), ...staleOpen]
      .filter((item) => (hiddenUntil[item.key] || 0) <= now)
      .sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [alerts, batches, hiddenUntil]);

  const openCount = batches.filter((batch) => batch.quantity > 0 && batch.open_unit_remaining_percent != null).length;

  function openSuggestionMenu(suggestion: Suggestion) {
    Alert.alert(suggestion.title, "Hide this suggestion?", [
      { text: "Cancel", style: "cancel" },
      { text: "Remind later", onPress: () => setHiddenUntil((value) => ({ ...value, [suggestion.key]: Date.now() + 4 * 3600000 })) },
      { text: "Dismiss", onPress: () => setHiddenUntil((value) => ({ ...value, [suggestion.key]: Number.MAX_SAFE_INTEGER })) },
    ]);
  }

  if (loading) return <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /><Text style={styles.loadingText}>Loading your fridge…</Text></View>;

  return <ScrollView style={styles.screen} contentContainerStyle={styles.container} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} />}>
    <ScreenHeader eyebrow="Fridge9000" title="Your Fridge" subtitle="See what needs attention or update your inventory." />

    {notice ? <View style={styles.notice}><Ionicons name="cloud-offline-outline" size={20} color={colors.warningFg} /><Text style={styles.noticeText}>{notice}</Text><Pressable onPress={() => loadData()}><Text style={styles.retry}>Retry</Text></Pressable></View> : null}

    <View style={styles.summaryRow}>
      <Summary emoji="🥛🥚" value={String(inventory.length)} label="Products" onPress={() => router.push("/inventory")} />
      <Summary emoji="⚠️" value={String(alerts.length)} label="Alerts" onPress={() => router.push("/alerts")} />
      <Summary icon="water-outline" value={String(openCount)} label="Open" onPress={() => router.push("/adjust-open-products")} />
    </View>

    <View style={styles.updateArea}>
      <AppButton label="Update inventory" icon="scan-outline" onPress={() => router.push("/update-inventory")} />
      <AppButton label="Rot Detection" icon="leaf-outline" variant="secondary" onPress={() => router.push("/rot-detection")} />
      <Text style={styles.updateHint}>Scan, upload a receipt, or update manually.</Text>
    </View>

    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open Teach Fridge 9000"
      onPress={() => router.push("/teach-fridge")}
      style={({ pressed }) => [styles.teachCard, pressed && styles.pressed]}
    >
      <View style={styles.teachIcon}><Ionicons name="school-outline" size={28} color={colors.primaryText} /></View>
      <View style={styles.teachCopy}>
        <StatusBadge label="LIVE AI LAB" tone="info" />
        <Text style={styles.teachTitle}>Teach Fridge 9000</Text>
        <Text style={styles.teachMessage}>Correct detections, add missed products, and watch your feedback improve the next model.</Text>
      </View>
      <Ionicons name="chevron-forward" size={22} color={colors.primary} />
    </Pressable>

    <SectionTitle title="Suggested updates" action={suggestions.length > 2 ? "View all" : undefined} onAction={() => router.push("/alerts")} />
    {suggestions.length ? suggestions.slice(0, 2).map((suggestion) => <Card key={suggestion.key}>
      <View style={styles.suggestionTop}>
        <View style={styles.suggestionCopy}><StatusBadge label={suggestion.label} tone={suggestion.tone} /><Text style={styles.suggestionTitle}>{suggestion.title}</Text><Text style={styles.suggestionMessage} numberOfLines={1}>{suggestion.message}</Text></View>
        <Pressable accessibilityLabel={`More options for ${suggestion.title}`} hitSlop={10} onPress={() => openSuggestionMenu(suggestion)}><Ionicons name="ellipsis-horizontal" size={23} color={colors.textMuted} /></Pressable>
      </View>
      <Pressable style={styles.suggestionAction} onPress={suggestion.route}><Text style={styles.suggestionActionText}>{suggestion.action}</Text><Ionicons name="arrow-forward" size={16} color={colors.primary} /></Pressable>
    </Card>) : <Card><EmptyState title="Everything looks good" message="No updates need your attention right now." /></Card>}

    <Pressable style={styles.activityLink} onPress={() => router.push("/events")}><Ionicons name="time-outline" size={18} color={colors.textMuted} /><Text style={styles.activityText}>Recent activity</Text><Ionicons name="chevron-forward" size={17} color={colors.textMuted} /></Pressable>
  </ScrollView>;
}

function Summary({ emoji, icon, value, label, onPress }: { emoji?: string; icon?: keyof typeof Ionicons.glyphMap; value: string; label: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value}. Open ${label}.`} onPress={onPress} style={({ pressed }) => [styles.summary, pressed && styles.pressed]}>
    {emoji ? <Text style={styles.summaryEmoji}>{emoji}</Text> : icon ? <Ionicons name={icon} size={22} color={colors.primary} /> : null}
    <Text style={styles.summaryValue}>{value}</Text><View style={styles.summaryLabelRow}><Text style={styles.summaryLabel}>{label}</Text><Ionicons name="chevron-forward" size={12} color={colors.textMuted} /></View>
  </Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, container: { padding: spacing.xl, gap: spacing.lg, paddingBottom: 44 }, center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, backgroundColor: colors.background }, loadingText: { color: colors.textMuted },
  notice: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.warningBg, borderRadius: radius.lg, padding: spacing.md }, noticeText: { flex: 1, color: colors.warningFg, fontSize: 13, lineHeight: 18 }, retry: { color: colors.warningFg, fontWeight: "800" },
  summaryRow: { flexDirection: "row", gap: spacing.sm }, summary: { flex: 1, minWidth: 0, minHeight: 112, backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.md, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", gap: 3, shadowColor: colors.navy, shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 1 }, summaryEmoji: { fontSize: 21 }, summaryValue: { fontSize: 22, fontWeight: "800", color: colors.navy }, summaryLabelRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2 }, summaryLabel: { fontSize: 13, color: colors.textMuted, fontWeight: "600", textAlign: "center", flexShrink: 1 }, pressed: { opacity: 0.68, transform: [{ scale: 0.98 }] },
  updateArea: { gap: 7 }, updateHint: { textAlign: "center", color: colors.textMuted, fontSize: 13 }, suggestionTop: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md }, suggestionCopy: { flex: 1, minWidth: 0, gap: spacing.xs }, suggestionTitle: { ...typography.section, fontSize: 17, color: colors.navy, marginTop: spacing.xs }, suggestionMessage: { color: colors.textMuted, lineHeight: 20 }, suggestionAction: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 4, marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border }, suggestionActionText: { color: colors.primary, fontWeight: "800" },
  teachCard: { backgroundColor: colors.primarySoft, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.primary, padding: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md, shadowColor: colors.navy, shadowOpacity: 0.09, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 3 },
  teachIcon: { width: 54, height: 54, borderRadius: 18, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  teachCopy: { flex: 1, gap: spacing.xs }, teachTitle: { ...typography.section, fontSize: 18, color: colors.navy }, teachMessage: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  activityLink: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingVertical: spacing.sm }, activityText: { color: colors.textMuted, fontWeight: "700", flex: 0 },
});
