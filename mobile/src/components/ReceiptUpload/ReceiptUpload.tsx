import { useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
  type ListRenderItem,
} from "react-native";
import { ReceiptItemRow } from "./ReceiptItemRow";
import { styles } from "./ReceiptUpload.styles";
import { useReceiptUpload } from "./useReceiptUpload";
import type { OcrProvider } from "../../services/receiptOcr";
import type { EditableReceiptItem } from "../../types/receipt";

export type ReceiptUploadProps = {
  ocrProvider?: OcrProvider;
  onSubmitted?: () => void;
};

export default function ReceiptUpload({
  ocrProvider,
  onSubmitted,
}: ReceiptUploadProps) {
  const { state, handlers, derived } = useReceiptUpload({
    ocrProvider,
    onSubmitted,
  });

  const progressPercent = state.progress
    ? Math.round((state.progress.progress ?? 0) * 100)
    : 0;

  const progressBarStyle = useMemo(
    () => [styles.progressBarInner, { width: `${progressPercent}%` as const }],
    [progressPercent],
  );

  const sourceBadge = useMemo(() => {
    if (state.source !== "ocr") return null;
    return (
      <View style={[styles.badge, styles.badgeOcr]}>
        <Text style={[styles.badgeText, styles.badgeOcrText]}>via OCR</Text>
      </View>
    );
  }, [state.source]);

  const renderItem = useCallback<ListRenderItem<EditableReceiptItem>>(
    ({ item }) => (
      <ReceiptItemRow
        id={item.id}
        name={item.name}
        quantity={item.quantity}
        price={item.price}
        included={item.included}
        onUpdate={handlers.updateItem}
        onRemove={handlers.removeItem}
      />
    ),
    [handlers.updateItem, handlers.removeItem],
  );

  const keyExtractor = useCallback(
    (item: EditableReceiptItem) => item.id,
    [],
  );

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Receipt Upload</Text>
      <Text style={styles.subtitle}>
        Pick a photo of a receipt — we&apos;ll OCR it (Hebrew + English) and
        let you review the items before adding to inventory.
      </Text>

      <View style={styles.pickerRow}>
        <Pressable
          onPress={handlers.pickFromGallery}
          style={styles.pickerBtn}
          accessibilityRole="button"
        >
          <Text style={styles.pickerBtnText}>📁 Gallery</Text>
        </Pressable>
        <Pressable
          onPress={handlers.takePhoto}
          style={styles.pickerBtn}
          accessibilityRole="button"
        >
          <Text style={styles.pickerBtnText}>📷 Camera</Text>
        </Pressable>
      </View>

      {state.pickedUri ? (
        <View style={styles.selectedFile}>
          <Text style={styles.selectedFileText} numberOfLines={1}>
            Selected: {state.pickedName ?? state.pickedUri.split("/").pop()}
          </Text>
        </View>
      ) : null}

      <Pressable
        onPress={handlers.parse}
        disabled={derived.parseDisabled}
        style={[
          styles.primaryBtn,
          derived.parseDisabled ? styles.primaryBtnDisabled : null,
        ]}
        accessibilityRole="button"
      >
        {state.parsing ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryBtnText}>📄 Parse Receipt</Text>
        )}
      </Pressable>

      <View style={styles.optionsRow}>
        <View style={styles.optionLabel}>
          <Switch
            value={state.tableOnly}
            onValueChange={handlers.setTableOnly}
          />
          <Text style={styles.optionText}>Only items in product table</Text>
        </View>
      </View>

      <Text style={styles.hint}>
        First run downloads OCR language data (Hebrew + English) on the server
        side. After that, parsing is fast.
      </Text>

      {state.progress ? (
        <View style={styles.progressWrap}>
          <View style={styles.progressLabelRow}>
            <Text style={styles.progressStage}>{state.progress.stage}</Text>
            <Text style={styles.progressMessage} numberOfLines={1}>
              {state.progress.message}
            </Text>
            <Text style={styles.progressPercent}>{progressPercent}%</Text>
          </View>
          <View style={styles.progressBarOuter}>
            <View style={progressBarStyle} />
          </View>
          {state.parsing ? (
            <Pressable onPress={handlers.cancel} style={styles.ghostBtn}>
              <Text style={styles.ghostBtnText}>Cancel</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {state.error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠️ {state.error}</Text>
        </View>
      ) : null}

      {state.info ? (
        <View style={styles.successBox}>
          <Text style={styles.successText}>✅ {state.info}</Text>
        </View>
      ) : null}

      {state.items.length > 0 ? (
        <>
          <View style={styles.itemsHeader}>
            <Text style={styles.itemsHeaderText}>
              Detected items: {state.items.length}
            </Text>
            {sourceBadge}
            {state.tableOnly ? (
              <View
                style={[
                  styles.badge,
                  state.tableDetected
                    ? styles.badgeTableFound
                    : styles.badgeTableMissing,
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    state.tableDetected
                      ? styles.badgeTableFoundText
                      : styles.badgeTableMissingText,
                  ]}
                >
                  {state.tableDetected ? "table found" : "no table found"}
                </Text>
              </View>
            ) : null}
          </View>

          <FlatList
            data={state.items}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            scrollEnabled={false}
            removeClippedSubviews
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={5}
          />

          <View style={styles.toolbar}>
            <Pressable
              onPress={handlers.addEmptyRow}
              style={[styles.ghostBtn, styles.toolbarBtn]}
            >
              <Text style={styles.ghostBtnText}>➕ Add row</Text>
            </Pressable>
            <Pressable
              onPress={handlers.submit}
              disabled={derived.submitDisabled}
              style={[
                styles.successBtn,
                styles.toolbarBtn,
                derived.submitDisabled ? styles.primaryBtnDisabled : null,
              ]}
            >
              {state.submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.successBtnText}>
                  Add {derived.includedCount}
                </Text>
              )}
            </Pressable>
          </View>
        </>
      ) : null}

      {state.rawText ? (
        <>
          <Pressable onPress={handlers.toggleShowRaw} style={styles.ghostBtn}>
            <Text style={styles.ghostBtnText}>
              {state.showRaw ? "Hide raw text" : "Show raw text"}
            </Text>
          </Pressable>
          {state.showRaw ? (
            <Text style={styles.rawBox} selectable>
              {derived.rawDisplay}
            </Text>
          ) : null}
          {state.tableRange && state.showRaw ? (
            <Text style={styles.caption}>
              ▶ marks lines inside the detected products table (lines{" "}
              {state.tableRange.start}–{state.tableRange.end - 1}).
            </Text>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
