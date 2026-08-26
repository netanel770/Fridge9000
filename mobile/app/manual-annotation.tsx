import { useState } from "react";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { BoundingBoxEditor } from "../src/components/BoundingBoxEditor";
import { AppButton, Card, ScreenHeader, StatusBadge } from "../src/components/ui";
import { createAnnotationSubmission, uploadManualAnnotationImage } from "../src/services/api";
import type { ManualAnnotationImageUpload } from "../src/types/api";
import { getMinimumAnnotationBoxSize } from "../src/utils/imageCoordinates";
import type { ImageBoundingBox } from "../src/utils/imageCoordinates";
import { colors, radius, spacing, typography } from "../src/theme";

type ManualProduct = {
  id: string;
  label: string;
  box: ImageBoundingBox;
};

export default function ManualAnnotationScreen() {
  const [asset, setAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [uploaded, setUploaded] = useState<ManualAnnotationImageUpload | null>(null);
  const [products, setProducts] = useState<ManualProduct[]>([]);
  const [label, setLabel] = useState("");
  const [box, setBox] = useState<ImageBoundingBox | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function applySelectedImage(selectedAsset: ImagePicker.ImagePickerAsset) {
    setAsset(selectedAsset);
    setUploaded(null);
    setProducts([]);
    resetEditor();
    setError("");
  }

  async function chooseImage() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.9,
    });
    if (result.canceled) return;
    applySelectedImage(result.assets[0]);
  }

  async function takePhoto() {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Camera permission needed",
          permission.canAskAgain
            ? "Allow camera access to take a photo for annotation."
            : "Camera access is disabled. Enable it in your device settings to take a photo.",
        );
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        quality: 0.9,
      });
      if (result.canceled) return;
      applySelectedImage(result.assets[0]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open the camera.");
    }
  }

  async function uploadImage() {
    if (!asset) return;
    setUploading(true);
    setError("");
    try {
      const result = await uploadManualAnnotationImage(
        asset.uri,
        asset.fileName || "manual-annotation.jpg",
        asset.mimeType || "image/jpeg",
      );
      setUploaded(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not upload the image.");
    } finally {
      setUploading(false);
    }
  }

  function resetEditor() {
    setLabel("");
    setBox(null);
    setEditingId(null);
  }

  function saveProduct() {
    if (!uploaded || !box || !label.trim()) {
      Alert.alert("Annotation incomplete", "Enter a product label and draw its bounding box.");
      return;
    }
    const minimum = getMinimumAnnotationBoxSize(uploaded.image_width, uploaded.image_height);
    if (box.x2 - box.x1 < minimum || box.y2 - box.y1 < minimum) {
      Alert.alert("Box too small", "Draw a larger box around the product.");
      return;
    }
    const product = {
      id: editingId || `${Date.now()}-${products.length}`,
      label: label.trim(),
      box,
    };
    setProducts((current) => editingId
      ? current.map((item) => item.id === editingId ? product : item)
      : [...current, product]);
    resetEditor();
  }

  function editProduct(product: ManualProduct) {
    setEditingId(product.id);
    setLabel(product.label);
    setBox({ ...product.box });
  }

  function removeProduct(id: string) {
    setProducts((current) => current.filter((item) => item.id !== id));
    if (editingId === id) resetEditor();
  }

  async function submitAnnotations() {
    if (!uploaded || products.length === 0) return;
    setSubmitting(true);
    setError("");
    try {
      await createAnnotationSubmission(uploaded.scan_id, products.map((product) => ({
        action: "ADD",
        source_detection_id: null,
        final_label: product.label,
        final_x1: product.box.x1,
        final_y1: product.box.y1,
        final_x2: product.box.x2,
        final_y2: product.box.y2,
      })));
      Alert.alert(
        "Annotations submitted",
        "Your contribution is pending moderation in Teach Fridge 9000.",
        [{ text: "Done", onPress: () => router.replace("/teach-fridge") }],
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not submit annotations.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <ScreenHeader
        eyebrow="Teach Fridge 9000"
        title="Annotate a new image"
        subtitle="Upload an image and label products yourself. No AI scan required."
      />

      <Card>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. Choose an image</Text>
          <Text style={styles.help}>The image is stored for annotation only and is never sent through product detection.</Text>
          <View style={styles.imageSourceActions}>
            <View style={styles.imageSourceAction}><AppButton label="Gallery" icon="images-outline" variant="secondary" onPress={chooseImage} /></View>
            <View style={styles.imageSourceAction}><AppButton label="Take Photo" icon="camera-outline" variant="secondary" onPress={takePhoto} /></View>
          </View>
          {asset ? <Text style={styles.selected}>{asset.fileName || "Image selected"}</Text> : null}
          {asset && !uploaded ? <AppButton label="Upload for annotation" icon="cloud-upload-outline" loading={uploading} onPress={uploadImage} /> : null}
          {uploaded ? <StatusBadge label="Ready to annotate" tone="success" /> : null}
        </View>
      </Card>

      {uploaded && asset ? <>
        <Card>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>2. Label a product</Text>
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="Product label"
              autoCapitalize="words"
              style={styles.input}
            />
            <BoundingBoxEditor
              imageUri={asset.uri}
              imageWidth={uploaded.image_width}
              imageHeight={uploaded.image_height}
              box={box}
              label={label.trim()}
              onBoxChange={setBox}
            />
            <AppButton label={editingId ? "Save changes" : "Add product"} icon={editingId ? "checkmark" : "add"} onPress={saveProduct} />
            {editingId ? <AppButton label="Cancel editing" variant="ghost" onPress={resetEditor} /> : null}
          </View>
        </Card>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>3. Review annotations</Text>
          {products.length === 0 ? <Text style={styles.help}>No products added yet. Draw a box above to add the first product.</Text> : null}
          {products.map((product, index) => (
            <Card key={product.id}>
              <View style={styles.productRow}>
                <View style={styles.productNumber}><Text style={styles.productNumberText}>{index + 1}</Text></View>
                <View style={styles.productCopy}>
                  <Text style={styles.productLabel}>{product.label}</Text>
                  <Text style={styles.coordinates}>{Math.round(product.box.x1)}, {Math.round(product.box.y1)} → {Math.round(product.box.x2)}, {Math.round(product.box.y2)}</Text>
                </View>
                <Pressable accessibilityLabel={`Edit ${product.label}`} onPress={() => editProduct(product)} hitSlop={8}><Ionicons name="pencil" size={21} color={colors.primary} /></Pressable>
                <Pressable accessibilityLabel={`Remove ${product.label}`} onPress={() => removeProduct(product.id)} hitSlop={8}><Ionicons name="trash-outline" size={21} color={colors.danger} /></Pressable>
              </View>
            </Card>
          ))}
          <AppButton label="Submit annotations" icon="send" loading={submitting} disabled={products.length === 0} onPress={submitAnnotations} />
        </View>
      </> : null}

      {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, paddingBottom: 48, gap: spacing.lg, backgroundColor: colors.background },
  section: { gap: spacing.md },
  sectionTitle: { ...typography.section, color: colors.navy },
  help: { ...typography.body, color: colors.textMuted, lineHeight: 21 },
  imageSourceActions: { flexDirection: "row", gap: spacing.sm },
  imageSourceAction: { flex: 1 },
  selected: { color: colors.textSecondary, fontWeight: "700", textAlign: "center" },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, backgroundColor: colors.surface, color: colors.textPrimary, paddingHorizontal: spacing.md, fontSize: 16 },
  productRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  productNumber: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.primarySoft },
  productNumberText: { color: colors.primary, fontWeight: "800" },
  productCopy: { flex: 1, gap: 3 },
  productLabel: { color: colors.navy, fontSize: 16, fontWeight: "800" },
  coordinates: { color: colors.textMuted, fontSize: 12 },
  error: { padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.dangerBg },
  errorText: { color: colors.danger, fontWeight: "700", textAlign: "center" },
});
