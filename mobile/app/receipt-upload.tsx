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
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";

import { uploadReceiptPdf } from "../src/services/api";

export default function ReceiptUploadScreen() {
  const [selectedFile, setSelectedFile] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function pickReceipt() {
    const result = await DocumentPicker.getDocumentAsync({
      type: [
        "application/pdf",
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/*",
      ],
      copyToCacheDirectory: true,
    });

    if (!result.canceled) {
      setSelectedFile(result.assets[0]);
    }
  }

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (permission.status !== "granted") {
      Alert.alert("Permission required", "Camera access is required to take a photo.");
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: false,
      quality: 0.8,
    });

    if (!result.canceled) {
      const asset = result.assets[0];
      setSelectedFile({
        ...asset,
        name: "receipt-photo.jpg",
        mimeType: asset.mimeType || "image/jpeg",
      });
    }
  }

  async function uploadReceipt() {
    if (!selectedFile) {
      Alert.alert("No file selected");
      return;
    }

    setLoading(true);

    try {
      const result = await uploadReceiptPdf(selectedFile);
      if (!result.scan_id) {
        throw new Error("Upload completed without a scan ID");
      }

      router.push({
        pathname: "/review",
        params: { mode: "Added", scanId: String(result.scan_id), source: "receipt" },
      });
    } catch (e: any) {
      Alert.alert("Upload failed", e.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Upload Receipt</Text>
      <Text style={styles.subtitle}>Upload a supermarket receipt PDF or image</Text>

      <Pressable style={styles.secondaryButton} onPress={takePhoto}>
        <Text style={styles.secondaryButtonText}>Take Photo</Text>
      </Pressable>

      <Pressable style={styles.secondaryButton} onPress={pickReceipt}>
        <Text style={styles.secondaryButtonText}>
          {selectedFile ? "Choose Another File" : "Pick Receipt"}
        </Text>
      </Pressable>

      <Text style={styles.fileText}>
        {selectedFile ? `Selected: ${selectedFile.name}` : "No receipt selected yet"}
      </Text>

      <Pressable
        style={[styles.primaryButton, (!selectedFile || loading) && styles.disabledButton]}
        onPress={uploadReceipt}
        disabled={!selectedFile || loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryButtonText}>Upload Receipt</Text>
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
