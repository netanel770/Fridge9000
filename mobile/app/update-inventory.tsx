import { router } from "expo-router";
import { View, Text, StyleSheet, Pressable } from "react-native";

export default function UpdateInventoryMenuScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Update Inventory</Text>
      <Text style={styles.subtitle}>Choose how you want to update your inventory</Text>

      <Pressable
        style={styles.card}
        onPress={() => router.push("/manual-inventory")}
      >
        <Text style={styles.cardTitle}>Manual Update</Text>
        <Text style={styles.cardText}>Add or remove products manually</Text>
      </Pressable>
      
      <Pressable
        style={styles.card}
        onPress={() => router.push("/image-inventory")}
      >
        <Text style={styles.cardTitle}>Update by Image</Text>
        <Text style={styles.cardText}>Use the AI model to detect products from an image</Text>
      </Pressable>

      <Pressable
        style={styles.card}
        onPress={() => router.push("/receipt-upload")}
      >
        <Text style={styles.cardTitle}>Upload Receipt</Text>
        <Text style={styles.cardText}>Add items from a supermarket PDF receipt</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    gap: 16,
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
    marginBottom: 8,
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 6,
  },
  cardText: {
    fontSize: 14,
    color: "#6b7280",
  },
});