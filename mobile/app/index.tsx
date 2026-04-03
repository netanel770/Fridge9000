import { useEffect, useState } from "react";
import { router } from "expo-router";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { getAlerts, getEvents, getInventory, getLatestScan } from "../src/services/api";

export default function HomeScreen() {
  const [inventoryCount, setInventoryCount] = useState(0);
  const [alertsCount, setAlertsCount] = useState(0);
  const [eventsCount, setEventsCount] = useState(0);
  const [latestScanTime, setLatestScanTime] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadData() {
    setLoading(true);
    setError("");

    try {
      const [inventory, alerts, events, latestScan] = await Promise.all([
        getInventory(),
        getAlerts(),
        getEvents(10),
        getLatestScan(),
      ]);

      setInventoryCount(inventory.length);
      setAlertsCount(alerts.length);
      setEventsCount(events.length);
      setLatestScanTime(latestScan?.created_at ?? null);
    } catch (e: any) {
      setError(e.message || "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Fridge 9000</Text>
      <Text style={styles.subtitle}>Mobile Dashboard</Text>

      {loading ? (
        <ActivityIndicator size="large" />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>System Summary</Text>
            <Text style={styles.cardText}>Inventory items: {inventoryCount}</Text>
            <Text style={styles.cardText}>Active alerts: {alertsCount}</Text>
            <Text style={styles.cardText}>Recent events loaded: {eventsCount}</Text>
            <Text style={styles.cardText}>
              Latest scan: {latestScanTime ? new Date(latestScanTime).toLocaleString() : "No scans yet"}
            </Text>
          </View>

          <Pressable style={styles.primaryButton} onPress={() => router.push("/scan")}>
            <Text style={styles.primaryButtonText}>Scan Fridge</Text>
          </Pressable>

          <View style={styles.grid}>
            <Pressable style={styles.navCard} onPress={() => router.push("/inventory")}>
              <Text style={styles.navTitle}>Inventory</Text>
              <Text style={styles.navText}>View all items</Text>
            </Pressable>

            <Pressable style={styles.navCard} onPress={() => router.push("/alerts")}>
              <Text style={styles.navTitle}>Alerts</Text>
              <Text style={styles.navText}>Low / missing items</Text>
            </Pressable>

            <Pressable style={styles.navCard} onPress={() => router.push("/events")}>
              <Text style={styles.navTitle}>Events</Text>
              <Text style={styles.navText}>Recent activity log</Text>
            </Pressable>
          </View>

          <Pressable style={styles.secondaryButton} onPress={loadData}>
            <Text style={styles.secondaryButtonText}>Refresh</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    gap: 16,
  },
  title: {
    fontSize: 30,
    fontWeight: "700",
    color: "#111827",
  },
  subtitle: {
    fontSize: 16,
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
    marginBottom: 10,
    color: "#111827",
  },
  cardText: {
    fontSize: 15,
    color: "#374151",
    marginBottom: 6,
  },
  primaryButton: {
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
  },
  secondaryButton: {
    backgroundColor: "#e5e7eb",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: "#111827",
    fontSize: 16,
    fontWeight: "700",
  },
  grid: {
    gap: 12,
  },
  navCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  navTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 4,
  },
  navText: {
    fontSize: 14,
    color: "#6b7280",
  },
  error: {
    color: "#b91c1c",
    fontSize: 15,
  },
});