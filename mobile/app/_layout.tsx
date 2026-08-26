import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { LifecycleJobProvider } from "../src/components/LifecycleJobProvider";
import { colors } from "../src/theme";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <LifecycleJobProvider>
      <StatusBar hidden />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.navy,
          headerTitleStyle: { fontWeight: "700" },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="inventory" options={{ title: "Inventory" }} />
        <Stack.Screen name="alerts" options={{ title: "Alerts" }} />
        <Stack.Screen name="events" options={{ title: "Events" }} />
        <Stack.Screen name="review" />
        <Stack.Screen name="update-inventory" options={{ title: "Update Inventory" }} />
        <Stack.Screen name="receipt-upload" options={{ title: "Upload Receipt" }} />
        <Stack.Screen name="manual-inventory" options={{ title: "Manual Update" }} />
        <Stack.Screen name="adjust-open-products" options={{ title: "Adjust Open Products" }} />
        <Stack.Screen name="adjust-open-product" options={{ title: "Open Product" }} />
        <Stack.Screen name="image-inventory" options={{ title: "Update by Image" }} />
        <Stack.Screen name="rot-detection" options={{ title: "Rot Detection" }} />
        <Stack.Screen name="teach-fridge" options={{ title: "Teach Fridge 9000" }} />
        <Stack.Screen name="manual-annotation" options={{ title: "Annotate Image" }} />
        <Stack.Screen name="expired-items" options={{ title: "Expired Products" }} />
        <Stack.Screen name="manual-confirm" options={{ title: "Confirm Update" }} />
      </Stack>
      </LifecycleJobProvider>
    </GestureHandlerRootView>
  );
}
