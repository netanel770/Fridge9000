import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Alert,
  Platform,
} from "react-native";

import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";

import { uploadReceiptPdf } from "../src/services/api";
import { AppButton, Card, ScreenHeader } from "../src/components/ui";
import { useWebImageAcquisition } from "../src/components/useWebImageAcquisition";
import { colors, spacing, typography } from "../src/theme";

export default function ReceiptUploadScreen() {
  const [selectedFile, setSelectedFile] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const webImages = useWebImageAcquisition({
    onImage: (image) => setSelectedFile({ uri: image.uri, name: image.fileName, mimeType: image.mimeType }),
    onError: (message) => Alert.alert("Camera unavailable", message),
  });

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
    if (Platform.OS === "web") {
      webImages.openWebcam();
      return;
    }
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
      {webImages.cameraModal}
      <ScreenHeader title="Upload receipt" subtitle="Choose a receipt photo, image, or PDF." />
      <Card>
        <View style={styles.actions}>
          <AppButton label={Platform.OS === "web" ? "Use Webcam" : "Take photo"} icon="camera-outline" variant="secondary" onPress={takePhoto} />
          <AppButton label={selectedFile ? "Choose another file" : Platform.OS === "web" ? "Upload receipt file" : "Choose receipt"} icon="document-attach-outline" variant="secondary" onPress={pickReceipt} />
          <Text style={styles.fileText} numberOfLines={2}>
            {selectedFile ? `Selected: ${selectedFile.name}` : "No receipt selected"}
          </Text>
          <AppButton label="Upload receipt" icon="cloud-upload-outline" loading={loading} disabled={!selectedFile} onPress={uploadReceipt} />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.lg,
    backgroundColor: colors.background,
  },
  actions: { gap: spacing.md },
  fileText: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: "center",
  },
});
