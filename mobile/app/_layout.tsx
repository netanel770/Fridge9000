import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#ffffff" },
          headerTintColor: "#111827",
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: "#f8fafc" },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Fridge 9000" }} />
        <Stack.Screen name="inventory" options={{ title: "Inventory" }} />
        <Stack.Screen name="alerts" options={{ title: "Alerts" }} />
        <Stack.Screen name="events" options={{ title: "Events" }} />
        <Stack.Screen name="scan" options={{ title: "Scan Fridge" }} />
        <Stack.Screen name="review" options={{ title: "Review Detections" }} />
      </Stack>
    </>
  );
}