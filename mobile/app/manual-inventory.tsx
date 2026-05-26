import { useCallback,useEffect, useState } from "react";
import { router,useFocusEffect } from "expo-router";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  FlatList,
  Alert,
} from "react-native";
import { getAllInventory } from "../src/services/api";
import type { InventoryItem } from "../src/types/api";

type Mode = "Added" | "Removed";

export default function ManualInventoryScreen() {
  const [mode, setMode] = useState<Mode>("Added");
  const [itemName, setItemName] = useState("");
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [quantityChange, setQuantityChange] = useState(1);
  const [suggestions, setSuggestions] = useState<InventoryItem[]>([]);
  const [removeSearchText, setRemoveSearchText] = useState("");

  async function loadInventory() {
    try {
      const data = await getAllInventory();
      setInventoryItems(data);
    } catch (e: any) {
      Alert.alert("Error", e.message || "Failed to load inventory");
    }
  }

  useFocusEffect(
  useCallback(() => {
    loadInventory();
  }, [])
  );

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setItemName("");
    setSelectedItem(null);
    setSuggestions([]);
    setQuantityChange(1);

    if (nextMode === "Removed") {
      loadInventory();
    }
  }

  async function handleSearch() {
    if (!itemName.trim()) {
      Alert.alert("Missing item", "Please type part of an item name.");
      return;
    }

    const results = await searchInventoryItems(itemName.trim());
    setSuggestions(results);

    if (results.length === 0) {
      Alert.alert("No matches", "No existing inventory items match this name.");
    }
  }

  function selectItem(item: InventoryItem) {
    setSelectedItem(item);
    setItemName(item.name);
    setSuggestions([]);
    setQuantityChange(1);
  }

  function increaseQty() {
    if (mode === "Removed" && selectedItem) {
      setQuantityChange((prev) => Math.min(selectedItem.quantity, prev + 1));
      return;
    }

    setQuantityChange((prev) => prev + 1);
  }

  function decreaseQty() {
    setQuantityChange((prev) => Math.max(1, prev - 1));
  }

  async function goToConfirm() {
    const name = itemName.trim();

    if (mode === "Removed" && !selectedItem) {
      Alert.alert("Missing item", "Please choose an item from the inventory list.");
      return;
    }

    if (mode === "Added" && !name) {
      Alert.alert("Missing item", "Please enter an item name.");
      return;
    }

    let beforeQty = selectedItem?.quantity ?? 0;

    if (mode === "Added" && !selectedItem) {
      const inventory = await getInventory();
      const existing = inventory.find(
        (item) => item.name.toLowerCase() === name.toLowerCase()
      );

      if (existing) {
        beforeQty = existing.quantity;
      }
    }

    const finalName = selectedItem?.name || name;

    const afterQty =
      mode === "Added"
        ? beforeQty + quantityChange
        : beforeQty - quantityChange;

    if (afterQty < 0) {
      Alert.alert(
        "Invalid quantity",
        `You only have ${beforeQty} units of this item.`
      );
      return;
    }

    router.push({
      pathname: "/manual-confirm",
      params: {
        itemName: finalName,
        mode,
        quantityChange: String(quantityChange),
        beforeQty: String(beforeQty),
        afterQty: String(afterQty),
      },
    });
  }
  const removableItems = inventoryItems
  .filter((item) => item.quantity > 0)
  .filter((item) =>
    item.name.toLowerCase().includes(removeSearchText.toLowerCase())
  );

const addSuggestions =
  itemName.trim().length > 0
    ? inventoryItems.filter((item) =>
        item.name.toLowerCase().includes(itemName.toLowerCase())
      )
    : [];
  return (

    <View style={styles.container}>
      <Text style={styles.title}>Manual Update</Text>
      <Text style={styles.subtitle}>Add or remove products manually</Text>

      <View style={styles.radioContainer}>
        <Pressable style={styles.radioRow} onPress={() => changeMode("Added")}>
          <View style={styles.radioOuter}>
            {mode === "Added" && <View style={styles.radioInner} />}
          </View>
          <Text style={styles.radioText}>Add Mode</Text>
        </Pressable>

        <Pressable style={styles.radioRow} onPress={() => changeMode("Removed")}>
          <View style={styles.radioOuter}>
            {mode === "Removed" && <View style={styles.radioInner} />}
          </View>
          <Text style={styles.radioText}>Remove Mode</Text>
        </Pressable>
      </View>

      {mode === "Added" ? (
        <>
          <Text style={styles.label}>Item name</Text>

         <TextInput
        value={itemName}
        onChangeText={(text) => {
        setItemName(text);
        setSelectedItem(null);
        }}
        placeholder="Type item name"
        style={styles.input}
        />

<FlatList
  data={addSuggestions}
            keyExtractor={(item) => String(item.id)}
            style={styles.suggestionsList}
            renderItem={({ item }) => (
              <Pressable
                style={[
                  styles.suggestionCard,
                  selectedItem?.id === item.id && styles.selectedCard,
                ]}
                onPress={() => selectItem(item)}
              >
                <Text style={styles.suggestionName}>{item.name}</Text>
                <Text style={styles.suggestionMeta}>Qty: {item.quantity}</Text>
              </Pressable>
            )}
          />
        </>
      ) : (
        <>
          <View style={styles.sectionHeader}>
          <Text style={styles.label}>Choose item to remove</Text>

          <TextInput
          value={removeSearchText}
          onChangeText={setRemoveSearchText}
          placeholder="Search..."
          style={styles.removeSearchInput}
          />
        </View>

          <FlatList
            data={removableItems}
            keyExtractor={(item) => String(item.id)}
            style={styles.inventoryList}
            renderItem={({ item }) => (
              <Pressable
                style={[
                  styles.inventoryCard,
                  selectedItem?.id === item.id && styles.selectedCard,
                ]}
                onPress={() => selectItem(item)}
              >
                <View>
                  <Text style={styles.suggestionName}>{item.name}</Text>
                  <Text style={styles.suggestionMeta}>Category: {item.category}</Text>
                </View>

                <Text style={styles.inventoryQty}>Qty: {item.quantity}</Text>
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>No items available to remove</Text>
            }
          />
        </>
      )}

      {selectedItem && (
        <Text style={styles.currentQty}>
          Current quantity: {selectedItem.quantity}
        </Text>
      )}

      <Text style={styles.label}>
        Quantity to {mode === "Added" ? "add" : "remove"}
      </Text>

      <View style={styles.qtyRow}>
        <Pressable style={styles.qtyButton} onPress={decreaseQty}>
          <Text style={styles.qtyButtonText}>-</Text>
        </Pressable>

        <Text style={styles.qtyValue}>{quantityChange}</Text>

        <Pressable style={styles.qtyButton} onPress={increaseQty}>
          <Text style={styles.qtyButtonText}>+</Text>
        </Pressable>
      </View>

      <Pressable style={styles.primaryButton} onPress={goToConfirm}>
        <Text style={styles.primaryButtonText}>Continue</Text>
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    gap: 14,
    backgroundColor: "#f8fafc",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#111827",
  },
  subtitle: {
    fontSize: 15,
    color: "#6b7280",
  },
  radioContainer: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    padding: 14,
    gap: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  radioRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#2563eb",
    alignItems: "center",
    justifyContent: "center",
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#2563eb",
  },
  radioText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111827",
  },
  label: {
    fontSize: 14,
    fontWeight: "700",
    color: "#374151",
  },
  inputRow: {
    flexDirection: "row",
    gap: 10,
  },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 48,
    fontSize: 16,
  },
  searchButton: {
    backgroundColor: "#e5e7eb",
    paddingHorizontal: 14,
    borderRadius: 12,
    justifyContent: "center",
  },
  searchText: {
    fontWeight: "700",
    color: "#111827",
  },
  currentQty: {
    fontSize: 14,
    color: "#2563eb",
    fontWeight: "700",
  },
  suggestionsList: {
    maxHeight: 180,
  },
  suggestionCard: {
    backgroundColor: "#fff",
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    marginBottom: 8,
  },
  suggestionName: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111827",
  },
  suggestionMeta: {
    color: "#6b7280",
    marginTop: 4,
  },
  qtyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
  },
  qtyButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#2563eb",
    alignItems: "center",
    justifyContent: "center",
  },
  qtyButtonText: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "700",
  },
  qtyValue: {
    fontSize: 24,
    fontWeight: "700",
    color: "#111827",
    minWidth: 40,
    textAlign: "center",
  },
  inventoryList: {
  maxHeight: 260,
},
inventoryCard: {
  backgroundColor: "#fff",
  padding: 12,
  borderRadius: 12,
  borderWidth: 1,
  borderColor: "#e5e7eb",
  marginBottom: 8,
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
},
inventoryQty: {
  fontSize: 15,
  fontWeight: "700",
  color: "#2563eb",
},
selectedCard: {
  borderColor: "#2563eb",
  borderWidth: 2,
},
empty: {
  textAlign: "center",
  color: "#6b7280",
  marginTop: 20,
},
  primaryButton: {
    marginTop: "auto",
    backgroundColor: "#10b981",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  sectionHeader: {
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
},
removeSearchInput: {
  flex: 1,
  backgroundColor: "#fff",
  borderWidth: 1,
  borderColor: "#d1d5db",
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 8,
},
  primaryButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});