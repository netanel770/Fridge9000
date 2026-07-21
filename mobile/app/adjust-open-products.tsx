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
import { getInventory, getInventoryBatches } from "../src/services/api";
import { API_BASE_URL } from "../src/services/config";
import type { InventoryBatchItem, InventoryItem } from "../src/types/api";

function ProductThumbnail({ itemId }: { itemId: number }) {
  const [available, setAvailable] = useState(true);
  return (
    <View style={styles.thumbnailBox}>
      {available ? (
        <Image
          source={{ uri: `${API_BASE_URL}/items/${itemId}/representative-image?generate=false` }}
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
        <Text style={styles.title}>Adjust Open Products</Text>
        <Text style={styles.subtitle}>Choose a product, then select its expiry batch.</Text>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search products"
          style={styles.search}
        />
      </View>

      <FlatList
        data={visibleItems}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} />}
        renderItem={({ item }) => {
          const itemBatches = batches.filter((batch) => batch.item_id === item.id);
          const openBatches = itemBatches.filter((batch) => batch.open_unit_remaining_percent != null);
          return (
            <Pressable
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
        ListEmptyComponent={<Text style={styles.empty}>No products found.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f8fafc" },
  header: { padding: 16, paddingBottom: 8 },
  title: { fontSize: 26, fontWeight: "700", color: "#111827" },
  subtitle: { color: "#6b7280", marginTop: 5 },
  search: { height: 46, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 12, backgroundColor: "#fff", paddingHorizontal: 12, marginTop: 14 },
  list: { padding: 16, paddingTop: 8, gap: 10, paddingBottom: 36 },
  card: { backgroundColor: "#fff", borderRadius: 14, padding: 12, borderWidth: 1, borderColor: "#e5e7eb", flexDirection: "row", alignItems: "center", gap: 12 },
  thumbnailBox: { width: 64, height: 64, borderRadius: 12, backgroundColor: "#f3f4f6", overflow: "hidden" },
  thumbnail: { width: "100%", height: "100%" },
  thumbnailFallback: { color: "#9ca3af", fontSize: 26, textAlign: "center", marginTop: 16 },
  cardContent: { flex: 1 },
  name: { color: "#111827", fontWeight: "700", fontSize: 17 },
  meta: { color: "#6b7280", marginTop: 4 },
  openStatus: { color: "#047857", fontWeight: "600", marginTop: 5, fontSize: 13 },
  closedStatus: { color: "#6b7280", marginTop: 5, fontSize: 13 },
  arrow: { color: "#2563eb", fontSize: 22, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { textAlign: "center", color: "#6b7280", marginTop: 30 },
});
