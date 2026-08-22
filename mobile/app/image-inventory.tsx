import { useState } from "react";
import { router } from "expo-router";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { uploadScanImage } from "../src/services/api";

type Mode = "Added" | "Removed";

export default function UpdateInventoryScreen() {
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("Added");
  const [loading, setLoading] = useState(false);

  async function pickImage() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.8,
    });

    if (!result.canceled) {
      setImageUri(result.assets[0].uri);
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
      setImageUri(result.assets[0].uri);
    }
  }

  async function uploadImage() {
    if (!imageUri) {
      Alert.alert("No image selected", "Please choose an image first.");
      return;
    }

    setLoading(true);

    try {
      const res = await uploadScanImage(imageUri);

      if (!res.ok) {
        throw new Error(res.error || "Upload failed");
      }
      if (!res.scan_id) {
        throw new Error("Upload completed without a scan ID");
      }

      router.push({
        pathname: "/review",
        params: { mode, scanId: String(res.scan_id) },
      });
    } catch (e: any) {
      Alert.alert("Upload failed", e.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Update by Image</Text>
      <Text style={styles.subtitle}>
        Choose whether the image should add or remove items from inventory
      </Text>

      <View style={styles.radioContainer}>
        <Pressable style={styles.radioRow} onPress={() => setMode("Added")}>
          <View style={styles.radioOuter}>{mode === "Added" && <View style={styles.radioInner} />}</View>
          <Text style={styles.radioText}>Add Mode</Text>
        </Pressable>

        <Pressable style={styles.radioRow} onPress={() => setMode("Removed")}>
          <View style={styles.radioOuter}>{mode === "Removed" && <View style={styles.radioInner} />}</View>
          <Text style={styles.radioText}>Remove Mode</Text>
        </Pressable>
      </View>

      <Pressable style={styles.secondaryButton} onPress={takePhoto}>
        <Text style={styles.secondaryButtonText}>Take Photo</Text>
      </Pressable>

      <Pressable style={styles.secondaryButton} onPress={pickImage}>
        <Text style={styles.secondaryButtonText}>
          {imageUri ? "Choose Another Image" : "Pick Image"}
        </Text>
      </Pressable>

      <Text style={styles.fileText}>
        {imageUri ? "Selected image ready for upload" : "No image selected yet"}
      </Text>

      <Pressable
        style={[styles.primaryButton, !imageUri && styles.disabledButton]}
        onPress={uploadImage}
        disabled={!imageUri || loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryButtonText}>
            {mode === "Added" ? "Add Items" : "Remove Items"}
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
  secondaryButtonText: {
    color: "#111827",
    fontSize: 16,
    fontWeight: "700",
  },
});
