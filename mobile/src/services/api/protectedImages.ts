import { Image, Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

import { API_BASE_URL } from "../config";
import { ApiError, requestApiResponse, requestWithAuthRetry } from "./client";

export type LoadedProtectedImage = {
  uri: string;
  release: () => Promise<void>;
};

let cacheSequence = 0;

export function isProtectedApiImageUri(uri: string) {
  return uri === API_BASE_URL || uri.startsWith(`${API_BASE_URL}/`);
}

function apiPath(uri: string) {
  return uri.slice(API_BASE_URL.length) || "/";
}

function fileExtension(uri: string) {
  try {
    return new URL(uri).pathname.match(/\.[a-z0-9]{1,5}$/i)?.[0] || ".img";
  } catch {
    return ".img";
  }
}

async function removeCachedFile(uri: string) {
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}

async function loadNativeImage(uri: string): Promise<LoadedProtectedImage> {
  if (!FileSystem.cacheDirectory) throw new Error("Image cache is unavailable");
  const destination = `${FileSystem.cacheDirectory}fridge9000-protected-${Date.now()}-${cacheSequence++}${fileExtension(uri)}`;
  try {
    const result = await requestWithAuthRetry(
      (headers) => FileSystem.downloadAsync(uri, destination, {
        headers: Object.fromEntries(headers.entries()),
        sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
      }),
    );
    if (result.status < 200 || result.status >= 300) {
      throw new ApiError(`Image request failed (${result.status})`, result.status);
    }
    return { uri: result.uri, release: () => removeCachedFile(result.uri) };
  } catch (error) {
    await removeCachedFile(destination);
    throw error;
  }
}

async function loadWebImage(uri: string): Promise<LoadedProtectedImage> {
  const response = await requestApiResponse(apiPath(uri), { cache: "no-store" });
  if (!response.ok) throw new ApiError(`Image request failed (${response.status})`, response.status);
  const objectUri = URL.createObjectURL(await response.blob());
  return {
    uri: objectUri,
    release: async () => { URL.revokeObjectURL(objectUri); },
  };
}

export function loadProtectedImage(uri: string) {
  if (!isProtectedApiImageUri(uri)) {
    return Promise.resolve<LoadedProtectedImage>({ uri, release: async () => undefined });
  }
  return Platform.OS === "web" ? loadWebImage(uri) : loadNativeImage(uri);
}

export async function getAuthenticatedImageSize(uri: string) {
  const image = await loadProtectedImage(uri);
  try {
    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      Image.getSize(image.uri, (width, height) => resolve({ width, height }), reject);
    });
  } finally {
    await image.release();
  }
}
