import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
} from "react-native";

import * as DocumentPicker from "expo-document-picker";
import { router } from "expo-router";

import { uploadReceiptPdf } from "../src/services/api";

export default function ReceiptUploadScreen() {
  const [fileUri, setFileUri] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [loading, setLoading] = useState(false);

  async function pickPdf() {
    const result = await DocumentPicker.getDocumentAsync({
      type: "application/pdf",
      copyToCacheDirectory: true,
    });

    if (!result.canceled) {
      setFileUri(result.assets[0].uri);
      setFileName(result.assets[0].name);
    }
  }

  async function uploadReceipt() {
    if (!fileUri) {
      Alert.alert("No PDF selected");
      return;
    }

    setLoading(true);

    try {
      await uploadReceiptPdf(fileUri);

      router.push({
        pathname: "/review",
        params: { mode: "Added" },
      });

    } catch (e: any) {
      Alert.alert(
        "Upload failed",
        e.message || "Unknown error"
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        Upload Receipt
      </Text>

      <Text style={styles.subtitle}>
        Upload a supermarket receipt PDF
      </Text>

      <Pressable
        style={styles.secondaryButton}
        onPress={pickPdf}
      >
        <Text style={styles.secondaryButtonText}>
          {fileUri ? "Choose Another PDF" : "Pick PDF"}
        </Text>
      </Pressable>

      <Text style={styles.fileText}>
        {fileUri
          ? `Selected: ${fileName}`
          : "No PDF selected yet"}
      </Text>

      <Pressable
        style={[
          styles.primaryButton,
          (!fileUri || loading) && styles.disabledButton,
        ]}
        onPress={uploadReceipt}
        disabled={!fileUri || loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryButtonText}>
            Upload Receipt
          </Text>
        )}
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
  },

  fileText: {
    fontSize: 14,
    color: "#374151",
  },

  primaryButton: {
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },

  disabledButton: {
    opacity: 0.5,
  },

  primaryButtonText: {
    color: "#fff",
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
});