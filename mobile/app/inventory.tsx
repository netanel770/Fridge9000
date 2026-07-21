import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Pressable,
} from "react-native";
import { getInventory, getInventoryBatches } from "../src/services/api";
import type { InventoryBatchItem, InventoryItem } from "../src/types/api";
import { formatIsraelTime } from "../src/utils/date";

export default function InventoryScreen() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [batches, setBatches] = useState<InventoryBatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [expandedItemId, setExpandedItemId] = useState<number | null>(null);

  async function loadData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    setError("");

    try {
      const [inventoryData, batchData] = await Promise.all([
        getInventory(),
        getInventoryBatches(),
      ]);
      setItems(inventoryData);
      setBatches(batchData);
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
      renderItem={({ item }) => {
        const itemBatches = batches.filter((batch) => batch.item_id === item.id);
        const isExpanded = expandedItemId === item.id;

        return (
          <View style={styles.card}>
            <Pressable
              onPress={() => setExpandedItemId(isExpanded ? null : item.id)}
              style={styles.cardHeader}
            >
              <View style={styles.rowBetween}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.qty}>Qty: {item.quantity}</Text>
              </View>

              <Text style={styles.meta}>Category: {item.category}</Text>
              <Text style={styles.meta}>Status: {item.status}</Text>
              <Text style={styles.meta}>
                Updated: {formatIsraelTime(item.last_updated)}
              </Text>
              {item.expiry_date ? (
                <Text style={styles.meta}>Next expiry: {item.expiry_date}</Text>
              ) : null}
            </Pressable>

            {isExpanded && (
              <View style={styles.batchList}>
                {itemBatches.length > 0 ? (
                  itemBatches.map((batch) => (
                    <View key={batch.id} style={styles.batchRow}>
                      <Text style={styles.batchText}>Qty: {batch.quantity}</Text>
                      <Text style={styles.batchText}>
                        Expires: {batch.expiry_date || batch.expiry_estimate_date || "Not set"}
                      </Text>
                      <Text style={styles.batchText}>
                        Source: {batch.expiry_source === "manual" ? "Manual" : "Estimated"}
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.batchText}>No batches recorded</Text>
                )}
              </View>
            )}
          </View>
        );
      }}
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
  cardHeader: {
    gap: 4,
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 4,
  },
  name: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
    flexShrink: 1,
  },
  qty: {
    fontSize: 16,
    fontWeight: "600",
    color: "#2563eb",
  },
  meta: {
    fontSize: 14,
    color: "#4b5563",
    marginTop: 2,
  },
  batchList: {
    marginTop: 12,
    gap: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
  },
  batchRow: {
    backgroundColor: "#f8fafc",
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  batchText: {
    fontSize: 13,
    color: "#374151",
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