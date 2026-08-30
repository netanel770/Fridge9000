import { Platform } from "react-native";

type NativeUploadFile = {
  uri: string;
  name: string;
  type: string;
};

export async function appendUploadFile(
  formData: FormData,
  fieldName: string,
  uri: string,
  fileName: string,
  mimeType: string,
): Promise<void> {
  if (Platform.OS === "web") {
    const response = await fetch(uri);

    if (!response.ok) {
      throw new Error(`Unable to read selected file (${response.status}).`);
    }

    const sourceBlob = await response.blob();
    const effectiveType = sourceBlob.type || mimeType;

    const blob =
      effectiveType && sourceBlob.type !== effectiveType
        ? new Blob([await sourceBlob.arrayBuffer()], { type: effectiveType })
        : sourceBlob;

    formData.append(fieldName, blob, fileName);
    return;
  }

  formData.append(
    fieldName,
    {
      uri,
      name: fileName,
      type: mimeType,
    } as NativeUploadFile as any,
  );
}
