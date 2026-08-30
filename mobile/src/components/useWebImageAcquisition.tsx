import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing, typography } from "../theme";

export type AcquiredWebImage = {
  uri: string;
  fileName: string;
  mimeType: string;
  width?: number;
  height?: number;
};

type Options = {
  onImage: (image: AcquiredWebImage) => void;
  onError: (message: string) => void;
};

function cameraErrorMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Camera permission was denied. You can still upload a picture.";
    if (error.name === "NotFoundError") return "No webcam was found. You can still upload a picture.";
    if (error.name === "NotReadableError") return "The webcam is already in use or unavailable. You can still upload a picture.";
    if (error.name === "SecurityError") return "Webcam access requires a secure browser context. You can still upload a picture.";
  }
  return "The webcam could not be started. You can still upload a picture.";
}

function WebCameraModal({ visible, onCapture, onClose }: {
  visible: boolean;
  onCapture: (file: File, width: number, height: number) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    if (!visible || Platform.OS !== "web") return;
    let active = true;
    setError("");
    setStarting(true);
    void (async () => {
      try {
        if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new DOMException("Webcam unavailable", "SecurityError");
        }
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (caught) {
        stopCamera();
        if (active) setError(cameraErrorMessage(caught));
      } finally {
        if (active) setStarting(false);
      }
    })();
    return () => {
      active = false;
      stopCamera();
    };
  }, [stopCamera, visible]);

  function close() {
    stopCamera();
    onClose();
  }

  async function capture() {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) {
      setError("The webcam is not ready yet. Try again or upload a picture.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setError("The camera frame could not be captured. Try again or upload a picture.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) {
      setError("The camera frame could not be captured. Try again or upload a picture.");
      return;
    }
    const file = new File([blob], `fridge9000-camera-${Date.now()}.jpg`, { type: "image/jpeg" });
    stopCamera();
    onCapture(file, canvas.width, canvas.height);
    onClose();
  }

  if (Platform.OS !== "web") return null;
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
    <View style={styles.backdrop}>
      <View style={styles.sheet}>
        <Text style={styles.title}>Use Webcam</Text>
        <Text style={styles.message}>Position the item clearly, then capture the frame.</Text>
        {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View> : null}
        {starting ? <Text style={styles.message}>Starting camera...</Text> : null}
        {globalThis.document ? <View style={styles.preview}>
          <video ref={videoRef} autoPlay muted playsInline style={{ width: "100%", maxHeight: 420, backgroundColor: "#111827" }} />
        </View> : null}
        <View style={styles.actions}>
          <Pressable style={styles.secondary} onPress={close}><Text style={styles.secondaryText}>Cancel</Text></Pressable>
          <Pressable style={[styles.primary, (starting || Boolean(error)) && styles.disabled]} disabled={starting || Boolean(error)} onPress={() => { void capture(); }}><Text style={styles.primaryText}>Capture</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

export function useWebImageAcquisition({ onImage, onError }: Options) {
  const [cameraVisible, setCameraVisible] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  const acceptFile = useCallback((file: File, width?: number, height?: number) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const uri = URL.createObjectURL(file);
    objectUrlRef.current = uri;
    onImage({ uri, fileName: file.name || "image.jpg", mimeType: file.type || "image/jpeg", width, height });
  }, [onImage]);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const uploadPicture = useCallback(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) acceptFile(file);
    };
    input.onerror = () => onError("The selected picture could not be opened.");
    input.click();
  }, [acceptFile, onError]);

  return {
    openWebcam: () => setCameraVisible(true),
    uploadPicture,
    cameraModal: <WebCameraModal visible={cameraVisible} onCapture={acceptFile} onClose={() => setCameraVisible(false)} />,
  };
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(15, 23, 42, 0.72)", justifyContent: "center", padding: spacing.lg },
  sheet: { width: "100%", maxWidth: 720, alignSelf: "center", backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  message: { ...typography.body, color: colors.textMuted },
  preview: { overflow: "hidden", borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
  primary: { backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  primaryText: { color: colors.primaryText, fontWeight: "800" },
  secondary: { backgroundColor: colors.surfaceMuted, borderRadius: radius.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  secondaryText: { color: colors.textPrimary, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerBg },
  errorText: { color: colors.danger, fontWeight: "700" },
});
