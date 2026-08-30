function hasExplicitTimeZone(value: string) {
  return /(?:z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
}

export function parseApiDate(dateValue: string) {
  const trimmed = dateValue.trim();
  const normalized = hasExplicitTimeZone(trimmed)
    ? trimmed
    : `${trimmed.replace(" ", "T")}Z`;

  return new Date(normalized);
}

export function formatIsraelTime(dateValue: string) {
  if (!dateValue) return "";

  return parseApiDate(dateValue).toLocaleString("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatIsraelDate(dateValue: string) {
  if (!dateValue) return "";

  return parseApiDate(dateValue).toLocaleDateString("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
