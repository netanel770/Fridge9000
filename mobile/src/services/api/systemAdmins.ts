import type { PublicUser } from "../../types/api";
import { requestJson } from "./client";

export function getSystemAdmins() {
  return requestJson<PublicUser[]>("/system-admins");
}

export function grantSystemAdmin(userId: number) {
  return requestJson<PublicUser>(`/system-admins/${userId}`, { method: "POST" });
}
