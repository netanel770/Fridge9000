import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const webMemoryFallback = new Map<string, string>();

function isWeb(): boolean {
  return Platform.OS === "web";
}

export async function getStoredValue(key: string): Promise<string | null> {
  if (isWeb()) {
    if (typeof window !== "undefined") {
      try {
        return window.localStorage.getItem(key) ?? webMemoryFallback.get(key) ?? null;
      } catch {
        // Some browser privacy modes expose localStorage but reject access.
      }
    }
    return webMemoryFallback.get(key) ?? null;
  }

  return SecureStore.getItemAsync(key);
}

export async function setStoredValue(
  key: string,
  value: string,
): Promise<void> {
  if (isWeb()) {
    webMemoryFallback.set(key, value);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Keep the in-memory session available for this browser tab.
      }
    }

    return;
  }

  await SecureStore.setItemAsync(key, value);
}

export async function deleteStoredValue(key: string): Promise<void> {
  if (isWeb()) {
    webMemoryFallback.delete(key);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // The in-memory value has still been cleared.
      }
    }

    return;
  }

  await SecureStore.deleteItemAsync(key);
}
