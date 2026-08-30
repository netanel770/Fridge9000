import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { AppButton } from "../../../../components/ui";
import { BoundingBoxEditor } from "../../../../components/BoundingBoxEditor";
import { DetectionImageViewer } from "../../../../components/DetectionImageViewer";
import { ProductLabelInput } from "../../../../components/ProductLabelInput";
import {
  getAnnotationSubmissionImageUrl,
  getScanImageUrl,
} from "../../../../services/api";
import type {
  DetectionItem,
  RecentScan,
} from "../../../../types/api";
import type { ImageBoundingBox } from "../../../../utils/imageCoordinates";
import { colors } from "../../../../theme";
import {
  contributionActionTitle,
  contributionDetection,
} from "../../annotationUtils";
import { styles } from "../../styles";
import type {
  BoxEditorTarget,
  Contribution,
} from "../../types";

export function AnnotationModals({
  imageDetection,
  selectedScan,
  detections,
  onCloseImage,
  editDetection,
  finalLabel,
  savingLabel,
  labelError,
  productLabelSuggestions,
  onChangeFinalLabel,
  onCloseLabel,
  onSaveLabel,
  removeDetection,
  removingDetectionId,
  removeError,
  onCloseRemove,
  onConfirmRemove,
  confirmDetection,
  confirmingDetectionId,
  confirmError,
  onCloseConfirm,
  onConfirmDetection,
  contributionImage,
  onCloseContributionImage,
  useAdminContributionImages = false,
  editContribution,
  contributionLabel,
  contributionEditError,
  savingContribution,
  onChangeContributionLabel,
  onCloseContributionEditor,
  onSaveContributionLabel,
  boxEditor,
  savingBox,
  boxError,
  onCloseBoxEditor,
  onBoxChange,
  onBoxLabelChange,
  onResetBox,
  onSaveBox,
}: {
  imageDetection: DetectionItem | null;
  selectedScan: RecentScan | null;
  detections: DetectionItem[];
  onCloseImage: () => void;
  editDetection: DetectionItem | null;
  finalLabel: string;
  savingLabel: boolean;
  labelError: string;
  productLabelSuggestions: string[];
  onChangeFinalLabel: (value: string) => void;
  onCloseLabel: () => void;
  onSaveLabel: () => void;
  removeDetection: DetectionItem | null;
  removingDetectionId: number | null;
  removeError: string;
  onCloseRemove: () => void;
  onConfirmRemove: () => void;
  confirmDetection: DetectionItem | null;
  confirmingDetectionId: number | null;
  confirmError: string;
  onCloseConfirm: () => void;
  onConfirmDetection: () => void;
  contributionImage: Contribution | null;
  onCloseContributionImage: () => void;
  useAdminContributionImages?: boolean;
  editContribution: Contribution | null;
  contributionLabel: string;
  contributionEditError: string;
  savingContribution: boolean;
  onChangeContributionLabel: (value: string) => void;
  onCloseContributionEditor: () => void;
  onSaveContributionLabel: () => void;
  boxEditor: BoxEditorTarget | null;
  savingBox: boolean;
  boxError: string;
  onCloseBoxEditor: () => void;
  onBoxChange: (box: ImageBoundingBox | null) => void;
  onBoxLabelChange: (label: string) => void;
  onResetBox: () => void;
  onSaveBox: () => void;
}) {
  const previewDetections = imageDetection
    ? detections.map((detection) =>
        detection.id === imageDetection.id ? imageDetection : detection,
      )
    : detections;

  return (
    <>
      <Modal
        visible={imageDetection !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={onCloseImage}
      >
        <View style={styles.imageBackdrop}>
          <View style={styles.imageModal}>
            <View style={styles.imageHeader}>
              <View>
                <Text style={styles.imageTitle}>
                  {imageDetection?.label}
                </Text>
                <Text style={styles.imageSubtitle}>
                  Pending corrected preview · Scan #{selectedScan?.id}
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Close image"
                onPress={onCloseImage}
                hitSlop={10}
              >
                <Ionicons name="close" size={27} color={colors.navy} />
              </Pressable>
            </View>

            {selectedScan ? (
              <DetectionImageViewer
                imageUri={getScanImageUrl(selectedScan.id)}
                imageWidth={selectedScan.image_width}
                imageHeight={selectedScan.image_height}
                detections={previewDetections}
                highlightedDetectionId={imageDetection?.id}
                style={styles.scanImage}
              />
            ) : null}

            <Text style={styles.imageNote}>
              Pending label and area corrections are shown on the highlighted
              product. The original model prediction remains unchanged until
              moderation and training.
            </Text>
          </View>
        </View>
      </Modal>

      <Modal
        visible={editDetection !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => !savingLabel && onCloseLabel()}
      >
        <KeyboardAvoidingView
          style={styles.imageBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <ScrollView
            contentContainerStyle={styles.labelModal}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
          >
            <View style={styles.imageHeader}>
              <View>
                <Text style={styles.imageTitle}>Correct product label</Text>
                <Text style={styles.imageSubtitle}>
                  Original: {editDetection?.label}
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Close label editor"
                disabled={savingLabel}
                onPress={onCloseLabel}
                hitSlop={10}
              >
                <Ionicons name="close" size={27} color={colors.navy} />
              </Pressable>
            </View>

            <Text style={styles.inputLabel}>Final product label</Text>
            <ProductLabelInput
              value={finalLabel}
              onChangeText={onChangeFinalLabel}
              suggestions={productLabelSuggestions}
              placeholder="Enter the correct label"
              autoFocus
              error={Boolean(labelError)}
            />
            {labelError ? (
              <Text style={styles.modalError}>{labelError}</Text>
            ) : null}

            <View style={styles.modalActions}>
              <AppButton
                label="Submit Correction"
                icon="checkmark"
                loading={savingLabel}
                onPress={onSaveLabel}
              />
              <AppButton
                label="Cancel"
                variant="ghost"
                disabled={savingLabel}
                onPress={onCloseLabel}
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={removeDetection !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() =>
          !removingDetectionId && onCloseRemove()
        }
      >
        <View style={styles.imageBackdrop}>
          <View style={styles.labelModal}>
            <View style={styles.confirmIcon}>
              <Ionicons
                name="trash-outline"
                size={28}
                color={colors.danger}
              />
            </View>
            <Text style={styles.confirmTitle}>Remove this detection?</Text>
            <Text style={styles.confirmMessage}>
              Mark{" "}
              <Text style={styles.confirmLabel}>
                {removeDetection?.label}
              </Text>{" "}
              as an incorrect YOLO detection? The original prediction will be
              preserved and your feedback will be submitted for review.
            </Text>
            {removeError ? (
              <Text style={styles.modalError}>{removeError}</Text>
            ) : null}

            <View style={styles.modalActions}>
              <AppButton
                label="Submit as False Positive"
                icon="trash-outline"
                variant="danger"
                loading={removingDetectionId !== null}
                onPress={onConfirmRemove}
              />
              <AppButton
                label="Cancel"
                variant="ghost"
                disabled={removingDetectionId !== null}
                onPress={onCloseRemove}
              />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={confirmDetection !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() =>
          !confirmingDetectionId && onCloseConfirm()
        }
      >
        <View style={styles.imageBackdrop}>
          <View style={styles.labelModal}>
            <View style={styles.confirmSuccessIcon}>
              <Ionicons
                name="checkmark"
                size={30}
                color={colors.successFg}
              />
            </View>
            <Text style={styles.confirmTitle}>
              Confirm this detection?
            </Text>
            <Text style={styles.confirmMessage}>
              Confirm that{" "}
              <Text style={styles.confirmLabel}>
                {confirmDetection?.label}
              </Text>{" "}
              and its bounding box are correct. The original YOLO prediction
              will remain unchanged.
            </Text>
            {confirmError ? (
              <Text style={styles.modalError}>{confirmError}</Text>
            ) : null}

            <View style={styles.modalActions}>
              <AppButton
                label="Confirm Detection"
                icon="checkmark-circle-outline"
                loading={confirmingDetectionId !== null}
                onPress={onConfirmDetection}
              />
              <AppButton
                label="Cancel"
                variant="ghost"
                disabled={confirmingDetectionId !== null}
                onPress={onCloseConfirm}
              />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={contributionImage !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={onCloseContributionImage}
      >
        <View style={styles.imageBackdrop}>
          <View style={styles.imageModal}>
            <View style={styles.imageHeader}>
              <View>
                <Text style={styles.imageTitle}>
                  {contributionImage
                    ? contributionActionTitle(contributionImage)
                    : "Contribution"}
                </Text>
                <Text style={styles.imageSubtitle}>
                  Corrected contribution preview · Scan #
                  {contributionImage?.submission.scan_id}
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Close contribution image"
                onPress={onCloseContributionImage}
                hitSlop={10}
              >
                <Ionicons name="close" size={27} color={colors.navy} />
              </Pressable>
            </View>

            {contributionImage ? (
              <DetectionImageViewer
                imageUri={
                  useAdminContributionImages
                    ? getAnnotationSubmissionImageUrl(
                        contributionImage.submission.id,
                      )
                    : getScanImageUrl(
                        contributionImage.submission.scan_id,
                      )
                }
                imageWidth={contributionImage.submission.image_width}
                imageHeight={contributionImage.submission.image_height}
                detections={[contributionDetection(contributionImage)]}
                highlightedDetectionId={
                  contributionDetection(contributionImage).id
                }
                style={styles.scanImage}
              />
            ) : null}

            <Text style={styles.imageNote}>
              The highlighted label and box show the combined pending
              correction stored for this product.
            </Text>
          </View>
        </View>
      </Modal>

      <Modal
        visible={editContribution !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() =>
          !savingContribution && onCloseContributionEditor()
        }
      >
        <KeyboardAvoidingView
          style={styles.imageBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <ScrollView
            contentContainerStyle={styles.labelModal}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
          >
            <View style={styles.imageHeader}>
              <View>
                <Text style={styles.imageTitle}>Edit pending label</Text>
                <Text style={styles.imageSubtitle}>
                  Original: {editContribution?.annotation.original_label}
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Close contribution editor"
                disabled={savingContribution}
                onPress={onCloseContributionEditor}
                hitSlop={10}
              >
                <Ionicons name="close" size={27} color={colors.navy} />
              </Pressable>
            </View>

            <Text style={styles.inputLabel}>Final product label</Text>
            <ProductLabelInput
              value={contributionLabel}
              onChangeText={onChangeContributionLabel}
              suggestions={productLabelSuggestions}
              placeholder="Enter the correct label"
              autoFocus
              error={Boolean(contributionEditError)}
            />
            {contributionEditError ? (
              <Text style={styles.modalError}>
                {contributionEditError}
              </Text>
            ) : null}

            <View style={styles.modalActions}>
              <AppButton
                label="Save Label"
                icon="checkmark"
                loading={savingContribution}
                onPress={onSaveContributionLabel}
              />
              <AppButton
                label="Cancel"
                variant="ghost"
                disabled={savingContribution}
                onPress={onCloseContributionEditor}
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={boxEditor !== null}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => !savingBox && onCloseBoxEditor()}
      >
        <KeyboardAvoidingView
          style={styles.boxEditorScreen}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.boxEditorScreenContent}>
            <View style={styles.imageHeader}>
              <View style={styles.detectionCopy}>
                <Text style={styles.imageTitle}>Edit bounding box</Text>
                <Text style={styles.imageSubtitle}>
                  Drag the box to move it · Drag a corner to resize
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Close box editor"
                disabled={savingBox}
                onPress={onCloseBoxEditor}
                hitSlop={10}
              >
                <Ionicons name="close" size={27} color={colors.navy} />
              </Pressable>
            </View>

            {boxEditor ? (
              <BoundingBoxEditor
                key={`box-editor-${boxEditor.scanId}-${boxEditor.source}`}
                imageUri={getScanImageUrl(boxEditor.scanId)}
                imageWidth={boxEditor.imageWidth}
                imageHeight={boxEditor.imageHeight}
                box={boxEditor.box}
                label={boxEditor.label}
                onBoxChange={onBoxChange}
              />
            ) : null}

            {boxEditor?.source === "add" ? (
              <>
                <Text style={styles.inputLabel}>Product label</Text>
                <ProductLabelInput
                  value={boxEditor.label}
                  onChangeText={onBoxLabelChange}
                  suggestions={productLabelSuggestions}
                  placeholder="Enter the missed product label"
                  error={Boolean(boxError && !boxEditor.label.trim())}
                />
              </>
            ) : null}

            {boxError ? (
              <Text style={styles.modalError}>{boxError}</Text>
            ) : null}

            <View style={styles.boxEditorActions}>
              <View style={styles.detectionAction}>
                <AppButton
                  label={boxEditor?.source === "add" ? "Clear Box" : "Reset"}
                  icon="refresh"
                  variant="ghost"
                  disabled={savingBox || !boxEditor?.box}
                  onPress={onResetBox}
                />
              </View>
              <View style={styles.detectionAction}>
                <AppButton
                  label="Save Box"
                  icon="checkmark"
                  loading={savingBox}
                  onPress={onSaveBox}
                />
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}
