import type { AlertItem, EventItem } from "../../types/api";
import { requestJson } from "./client";

export function getAlerts(signal?: AbortSignal): Promise<AlertItem[]> {
  return requestJson<AlertItem[]>("/alerts", { signal });
}

export function getEvents(limit = 20): Promise<EventItem[]> {
  return requestJson<EventItem[]>(`/events?limit=${limit}`);
}
