import type { AuthSessionResponse, PublicUser } from "../../types/api";
import { JSON_HEADERS, requestJson } from "./client";

export function registerPassword(email: string, password: string, displayName?: string) {
  return requestJson<AuthSessionResponse>("/auth/register/password", {
    method: "POST", headers: JSON_HEADERS, auth: false,
    body: JSON.stringify({ email, password, display_name: displayName?.trim() || null }),
  });
}

export function loginPassword(email: string, password: string) {
  return requestJson<AuthSessionResponse>("/auth/login/password", {
    method: "POST", headers: JSON_HEADERS, auth: false,
    body: JSON.stringify({ email, password }),
  });
}

export function loginGoogle(idToken: string) {
  return requestJson<AuthSessionResponse>("/auth/google", {
    method: "POST", headers: JSON_HEADERS, auth: false,
    body: JSON.stringify({ id_token: idToken }),
  });
}

export function refreshSession(refreshToken: string) {
  return requestJson<AuthSessionResponse>("/auth/refresh", {
    method: "POST", headers: JSON_HEADERS, auth: false, retryAuth: false,
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

export function logoutSession(refreshToken: string) {
  return requestJson<{ ok: true }>("/auth/logout", {
    method: "POST", headers: JSON_HEADERS, auth: false, retryAuth: false,
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

export function getCurrentUser() {
  return requestJson<PublicUser>("/auth/me");
}
