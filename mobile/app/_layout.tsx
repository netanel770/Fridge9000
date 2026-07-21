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
        <Stack.Screen name="index" options={{ title: "Home 9000" }} />
        <Stack.Screen name="inventory" options={{ title: "Inventory" }} />
        <Stack.Screen name="alerts" options={{ title: "Alerts" }} />
        <Stack.Screen name="events" options={{ title: "Events" }} />
        <Stack.Screen name="review" />
        <Stack.Screen name="update-inventory" options={{ title: "Update Inventory" }} />
        <Stack.Screen name="upload-receipt" options={{ title: "Upload Receipt" }} />
        <Stack.Screen name="manual-inventory" options={{ title: "Manual Update" }} />
        <Stack.Screen name="image-inventory" options={{ title: "Update by Image" }} />
        <Stack.Screen name="expired-items" options={{ title: "Expired Products" }} />
        <Stack.Screen name="manual-confirm" options={{ title: "Confirm Update" }} />
      </Stack>
    </>
  );
}
