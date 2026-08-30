import type { HouseholdMembership, HouseholdMembersResponse } from "../../types/api";
import { JSON_HEADERS, requestJson } from "./client";

export function createHousehold(name: string) {
  return requestJson<{ id: number; name: string; join_code: string; role: "OWNER"; status: "ACTIVE" }>("/fridges", {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name }),
  });
}

export function joinHousehold(joinCode: string) {
  return requestJson<HouseholdMembership>("/fridges/join", {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ join_code: joinCode }),
  });
}

export function getMyHouseholds() {
  return requestJson<HouseholdMembership[]>("/fridges/mine");
}

export function getHouseholdMembers(fridgeId: number) {
  return requestJson<HouseholdMembersResponse>(`/fridges/${fridgeId}/members`);
}

export function manageHouseholdMember(fridgeId: number, userId: number, action: "approve" | "reject" | "remove") {
  return requestJson<{ user_id: number; role: string; status: string }>(`/fridges/${fridgeId}/members/${userId}/${action}`, { method: "POST" });
}
