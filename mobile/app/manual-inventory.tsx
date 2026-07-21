import { useCallback, useMemo, useState } from "react";
import { router, useFocusEffect } from "expo-router";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { getAllInventory, getInventoryBatches } from "../src/services/api";
import type { InventoryBatchItem, InventoryItem } from "../src/types/api";

type Mode = "Added" | "Removed";

function suggestedExpiryDate(itemName: string) {
  const name = itemName.toLowerCase();
  const result = new Date();
  if (["milk", "yogurt", "cream", "cheese", "butter"].some((token) => name.includes(token))) {
    result.setDate(result.getDate() + 7);
  } else if (["meat", "chicken", "fish", "salami", "ham"].some((token) => name.includes(token))) {
    result.setDate(result.getDate() + 3);
  } else if (["tomato", "cucumber", "lettuce", "avocado", "apple", "banana", "orange", "carrot", "eggplant"].some((token) => name.includes(token))) {
    result.setDate(result.getDate() + 5);
  } else if (["bread", "pita", "bun", "bagel"].some((token) => name.includes(token))) {
    result.setDate(result.getDate() + 3);
  } else {
    result.setDate(result.getDate() + 14);
  }
  const year = result.getFullYear();
  const month = String(result.getMonth() + 1).padStart(2, "0");
  const day = String(result.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return parsed.getFullYear() === Number(match[1])
    && parsed.getMonth() === Number(match[2]) - 1
    && parsed.getDate() === Number(match[3]);
}

function effectiveExpiry(batch: InventoryBatchItem) {
  return batch.expiry_date || batch.expiry_estimate_date || null;
}

function todayDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function ManualInventoryScreen() {
  const [mode, setMode] = useState<Mode>("Added");
  const [itemName, setItemName] = useState("");
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [inventoryBatches, setInventoryBatches] = useState<InventoryBatchItem[]>([]);
  const [quantityChange, setQuantityChange] = useState(1);
  const [removeSearchText, setRemoveSearchText] = useState("");
  const [expiryDate, setExpiryDate] = useState(suggestedExpiryDate(""));
  const [expiryManuallyEdited, setExpiryManuallyEdited] = useState(false);
  const [selectedRemovalExpiry, setSelectedRemovalExpiry] = useState<string | null>(null);

  async function loadInventory() {
    try {
      const [items, batches] = await Promise.all([getAllInventory(), getInventoryBatches()]);
      setInventoryItems(items);
      setInventoryBatches(batches);
    } catch (e: any) {
      Alert.alert("Error", e.message || "Failed to load inventory");
    }
  }

  useFocusEffect(useCallback(() => {
    loadInventory();
  }, []));

  const addSuggestions = useMemo(() => itemName.trim()
    ? inventoryItems.filter((item) => item.name.toLowerCase().includes(itemName.toLowerCase()))
    : [], [inventoryItems, itemName]);

  const removableItems = useMemo(() => inventoryItems
    .filter((item) => item.quantity > 0)
    .filter((item) => item.name.toLowerCase().includes(removeSearchText.toLowerCase())),
  [inventoryItems, removeSearchText]);

  const removalExpiryOptions = useMemo(() => {
    if (!selectedItem) return [];
    const quantities = new Map<string, number>();
    inventoryBatches
      .filter((batch) => batch.item_id === selectedItem.id && batch.quantity > 0)
      .forEach((batch) => {
        const date = effectiveExpiry(batch);
        if (date) quantities.set(date, (quantities.get(date) || 0) + batch.quantity);
      });
    return [...quantities.entries()]
      .map(([date, quantity]) => ({ date, quantity }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [inventoryBatches, selectedItem]);

  const selectedDateQuantity = removalExpiryOptions.find(
    (option) => option.date === selectedRemovalExpiry
  )?.quantity || 0;

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setItemName("");
    setSelectedItem(null);
    setQuantityChange(1);
    setRemoveSearchText("");
    setSelectedRemovalExpiry(null);
    setExpiryDate(suggestedExpiryDate(""));
    setExpiryManuallyEdited(false);
  }

  function selectItem(item: InventoryItem) {
    setSelectedItem(item);
    setItemName(item.name);
    setQuantityChange(1);
    setSelectedRemovalExpiry(null);
    if (mode === "Added") {
      setExpiryDate(suggestedExpiryDate(item.name));
      setExpiryManuallyEdited(false);
    }
  }

  function increaseQty() {
    if (mode === "Removed") {
      if (!selectedRemovalExpiry) {
        Alert.alert("Choose expiry date", "Select an expiry date before choosing the quantity.");
        return;
      }
      setQuantityChange((previous) => Math.min(selectedDateQuantity, previous + 1));
    } else {
      setQuantityChange((previous) => previous + 1);
    }
  }

  function goToConfirm() {
    const existingItem = selectedItem || inventoryItems.find(
      (item) => item.name.toLowerCase() === itemName.trim().toLowerCase()
    ) || null;
    const name = existingItem?.name || itemName.trim();
    if (!name) {
      Alert.alert("Missing item", "Please enter or select an item.");
      return;
    }
    if (mode === "Removed" && !selectedItem) {
      Alert.alert("Missing item", "Please select the correct product label from inventory.");
      return;
    }

    const finalExpiryDate = mode === "Removed" ? selectedRemovalExpiry : expiryDate;
    if (!finalExpiryDate || !isValidDate(finalExpiryDate)) {
      Alert.alert("Invalid expiry date", "Enter or select a valid date in YYYY-MM-DD format.");
      return;
    }
    if (mode === "Added" && finalExpiryDate < todayDate()) {
      Alert.alert("Invalid expiry date", "The expiry date cannot be in the past.");
      return;
    }
    if (mode === "Removed" && quantityChange > selectedDateQuantity) {
      Alert.alert("Not enough inventory", `Only ${selectedDateQuantity} item(s) are available for this expiry date.`);
      return;
    }

    const beforeQty = existingItem?.quantity ?? 0;
    const afterQty = mode === "Added" ? beforeQty + quantityChange : beforeQty - quantityChange;
    router.push({
      pathname: "/manual-confirm",
      params: {
        itemName: name,
        mode,
        quantityChange: String(quantityChange),
        beforeQty: String(beforeQty),
        afterQty: String(afterQty),
        expiryDate: finalExpiryDate,
        expirySource: mode === "Added" && !expiryManuallyEdited ? "estimated" : "manual",
      },
    });
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Text style={styles.title}>Manual Update</Text>
        <Text style={styles.subtitle}>Add or remove products by expiry date</Text>

        <View style={styles.modeBox}>
          {(["Added", "Removed"] as Mode[]).map((value) => (
            <Pressable key={value} style={styles.modeRow} onPress={() => changeMode(value)}>
              <View style={styles.radioOuter}>{mode === value && <View style={styles.radioInner} />}</View>
              <Text style={styles.modeText}>{value === "Added" ? "Add Mode" : "Remove Mode"}</Text>
            </Pressable>
          ))}
        </View>

        {mode === "Added" ? (
          <>
            <Text style={styles.label}>Product label</Text>
            <TextInput
              value={itemName}
              onChangeText={(text) => {
                setItemName(text);
                setSelectedItem(null);
                if (!expiryManuallyEdited) setExpiryDate(suggestedExpiryDate(text));
              }}
              placeholder="Type item name"
              style={styles.input}
            />
            {addSuggestions.slice(0, 5).map((item) => (
              <Pressable key={item.id} style={styles.itemCard} onPress={() => selectItem(item)}>
                <Text style={styles.itemName}>{item.name}</Text>
                <Text style={styles.itemMeta}>Current quantity: {item.quantity}</Text>
              </Pressable>
            ))}

            <Text style={styles.label}>Expiry date</Text>
            <TextInput
              value={expiryDate}
              onChangeText={(text) => { setExpiryDate(text); setExpiryManuallyEdited(true); }}
              placeholder="YYYY-MM-DD"
              style={styles.input}
              autoCapitalize="none"
              keyboardType="numbers-and-punctuation"
            />
            <Text style={styles.hint}>
              {expiryManuallyEdited ? "Manual expiry date" : "Suggested automatically — you can edit it"}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.label}>Choose the correct product label</Text>
            <TextInput
              value={removeSearchText}
              onChangeText={setRemoveSearchText}
              placeholder="Search inventory"
              style={styles.input}
            />
            <View style={styles.listBox}>
              {removableItems.slice(0, 10).map((item) => (
                <Pressable
                  key={item.id}
                  style={[styles.inventoryRow, selectedItem?.id === item.id && styles.selectedCard]}
                  onPress={() => selectItem(item)}
                >
                  <View>
                    <Text style={styles.itemName}>{item.name}</Text>
                    <Text style={styles.itemMeta}>{item.category}</Text>
                  </View>
                  <Text style={styles.quantityText}>Qty: {item.quantity}</Text>
                </Pressable>
              ))}
            </View>

            {selectedItem && (
              <>
                <Text style={styles.label}>Choose expiry date</Text>
                {removalExpiryOptions.length ? removalExpiryOptions.map((option) => (
                  <Pressable
                    key={option.date}
                    style={[styles.expiryRow, selectedRemovalExpiry === option.date && styles.selectedCard]}
                    onPress={() => { setSelectedRemovalExpiry(option.date); setQuantityChange(1); }}
                  >
                    <Text style={styles.expiryText}>{option.date}</Text>
                    <Text style={styles.itemMeta}>Available: {option.quantity}</Text>
                  </Pressable>
                )) : <Text style={styles.errorText}>This product has no dated inventory batches.</Text>}
              </>
            )}
          </>
        )}

        <Text style={styles.label}>Quantity to {mode === "Added" ? "add" : "remove"}</Text>
        <View style={styles.qtyRow}>
          <Pressable style={styles.qtyButton} onPress={() => setQuantityChange((value) => Math.max(1, value - 1))}>
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
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f8fafc" },
  container: { flexGrow: 1, padding: 20, gap: 12, paddingBottom: 36 },
  title: { fontSize: 28, fontWeight: "700", color: "#111827" },
  subtitle: { fontSize: 15, color: "#6b7280", marginBottom: 2 },
  modeBox: { backgroundColor: "#fff", borderRadius: 14, padding: 14, gap: 14, borderWidth: 1, borderColor: "#e5e7eb" },
  modeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  radioOuter: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: "#2563eb", alignItems: "center", justifyContent: "center" },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#2563eb" },
  modeText: { fontSize: 16, fontWeight: "600", color: "#111827" },
  label: { fontSize: 14, fontWeight: "700", color: "#374151", marginTop: 4 },
  input: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#d1d5db", borderRadius: 12, paddingHorizontal: 12, height: 48, fontSize: 16 },
  hint: { color: "#6b7280", fontSize: 13, marginTop: -6 },
  itemCard: { backgroundColor: "#fff", padding: 11, borderRadius: 10, borderWidth: 1, borderColor: "#e5e7eb" },
  itemName: { fontSize: 16, fontWeight: "700", color: "#111827" },
  itemMeta: { color: "#6b7280", marginTop: 3 },
  listBox: { maxHeight: 265, gap: 8 },
  inventoryRow: { backgroundColor: "#fff", padding: 12, borderRadius: 10, borderWidth: 1, borderColor: "#e5e7eb", flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  selectedCard: { borderColor: "#2563eb", borderWidth: 2, backgroundColor: "#eff6ff" },
  quantityText: { color: "#2563eb", fontWeight: "700" },
  expiryRow: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#d1d5db", borderRadius: 10, padding: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  expiryText: { color: "#111827", fontWeight: "700" },
  errorText: { color: "#b91c1c", paddingVertical: 8 },
  qtyRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 20 },
  qtyButton: { width: 46, height: 46, borderRadius: 23, backgroundColor: "#2563eb", alignItems: "center", justifyContent: "center" },
  qtyButtonText: { color: "#fff", fontSize: 27, fontWeight: "700" },
  qtyValue: { fontSize: 24, fontWeight: "700", color: "#111827", minWidth: 40, textAlign: "center" },
  primaryButton: { marginTop: 8, backgroundColor: "#10b981", paddingVertical: 14, borderRadius: 12, alignItems: "center" },
  primaryButtonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
