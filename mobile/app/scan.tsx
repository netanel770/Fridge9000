import { useState } from "react";
import { router } from "expo-router";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
  Platform,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useWebImageAcquisition } from "../src/components/useWebImageAcquisition";
import { uploadScanImage } from "../src/services/api";

export default function ScanScreen() {
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const webImages = useWebImageAcquisition({
    onImage: (image) => setImageUri(image.uri),
    onError: (message) => Alert.alert("Image unavailable", message),
  });

  async function pickImage() {
    if (Platform.OS === "web") {
      webImages.uploadPicture();
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
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

      router.push({ pathname: "/review", params: { scanId: String(res.scan_id) } });
    } catch (e: any) {
      Alert.alert("Upload failed", e.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Scan Fridge</Text>
      <Text style={styles.subtitle}>
        {Platform.OS === "web" ? "Use your webcam or upload a fridge image" : "Choose a fridge image from your gallery"}
      </Text>

      {Platform.OS === "web" ? <Pressable style={styles.secondaryButton} onPress={webImages.openWebcam}>
        <Text style={styles.secondaryButtonText}>Use Webcam</Text>
      </Pressable> : null}

      <Pressable style={styles.secondaryButton} onPress={pickImage}>
        <Text style={styles.secondaryButtonText}>
          {imageUri ? "Choose Another Image" : Platform.OS === "web" ? "Upload Picture" : "Pick Image"}
        </Text>
      </Pressable>

      {imageUri ? (
        <Text style={styles.fileText}>Selected image ready for upload</Text>
      ) : (
        <Text style={styles.fileText}>No image selected yet</Text>
      )}

      <Pressable
        style={[styles.primaryButton, !imageUri && styles.disabledButton]}
        onPress={uploadImage}
        disabled={!imageUri || loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryButtonText}>Upload Image</Text>
        )}
      </Pressable>
      {webImages.cameraModal}
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
