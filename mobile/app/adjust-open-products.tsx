import { useCallback, useMemo, useState } from "react";
import { router, useFocusEffect } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { getApiRequestHeaders, getInventory, getInventoryBatches } from "../src/services/api";
import { API_BASE_URL } from "../src/services/config";
import type { InventoryBatchItem, InventoryItem } from "../src/types/api";
import { EmptyState, ScreenHeader } from "../src/components/ui";
import { colors, radius, spacing } from "../src/theme";

function ProductThumbnail({ itemId }: { itemId: number }) {
  const [available, setAvailable] = useState(true);
  return (
    <View style={styles.thumbnailBox}>
      {available ? (
        <Image
          source={{ uri: `${API_BASE_URL}/items/${itemId}/representative-image?generate=false`, headers: getApiRequestHeaders() }}
          style={styles.thumbnail}
          resizeMode="contain"
          onError={() => setAvailable(false)}
        />
      ) : (
        <Text style={styles.thumbnailFallback}>[ ]</Text>
      )}
    </View>
  );
}

export default function AdjustOpenProductsScreen() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [batches, setBatches] = useState<InventoryBatchItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function loadData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [inventory, inventoryBatches] = await Promise.all([
        getInventory(),
        getInventoryBatches(),
      ]);
      setItems(inventory);
      setBatches(inventoryBatches);
    } catch (e: any) {
      Alert.alert("Load failed", e.message || "Could not load products.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useFocusEffect(useCallback(() => {
    loadData();
  }, []));

  const visibleItems = useMemo(() => items.filter((item) =>
    item.quantity > 0 && item.name.toLowerCase().includes(search.toLowerCase())
  ), [items, search]);

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" /></View>;
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <ScreenHeader title="Adjust open products" subtitle="Choose a product and expiry batch." />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search products"
          placeholderTextColor={colors.textMuted}
          style={styles.search}
        />
      </View>

      <FlatList
        data={visibleItems}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} />}
        renderItem={({ item }) => {
          const itemBatches = batches.filter((batch) => batch.item_id === item.id);
          const openBatches = itemBatches.filter((batch) => batch.open_unit_remaining_percent != null);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Adjust ${item.name}`}
              style={styles.card}
              onPress={() => router.push({
                pathname: "/adjust-open-product",
                params: { itemId: String(item.id), itemName: item.name },
              })}
            >
              <ProductThumbnail itemId={item.id} />
              <View style={styles.cardContent}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.meta}>{item.category} · {item.quantity} unit(s)</Text>
                <Text style={openBatches.length ? styles.openStatus : styles.closedStatus}>
                  {openBatches.length
                    ? `${openBatches.length} open batch${openBatches.length > 1 ? "es" : ""}`
                    : "No open unit tracked"}
                </Text>
              </View>
              <Text style={styles.arrow}>{">"}</Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={<EmptyState icon="search-outline" title="No products found" message="Try a different product name." />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { padding: spacing.lg, paddingBottom: spacing.sm },
  search: { height: 48, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, backgroundColor: colors.surface, color: colors.textPrimary, paddingHorizontal: spacing.md, fontSize: 16, marginTop: spacing.sm },
  list: { padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.sm, paddingBottom: 44 },
  card: { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.md, borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: spacing.md },
  thumbnailBox: { width: 64, height: 64, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted, overflow: "hidden" },
  thumbnail: { width: "100%", height: "100%" },
  thumbnailFallback: { color: colors.textMuted, fontSize: 26, textAlign: "center", marginTop: 16 },
  cardContent: { flex: 1, minWidth: 0 },
  name: { color: colors.navy, fontWeight: "700", fontSize: 17, flexShrink: 1 },
  meta: { color: colors.textMuted, marginTop: 4, flexShrink: 1 },
  openStatus: { color: "#047857", fontWeight: "600", marginTop: 5, fontSize: 13 },
  closedStatus: { color: "#6b7280", marginTop: 5, fontSize: 13 },
  arrow: { color: colors.primary, fontSize: 22, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
