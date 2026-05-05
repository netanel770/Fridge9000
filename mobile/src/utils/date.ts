export function formatIsraelTime(dateValue: string) {
  if (!dateValue) return "";

  const normalized =
    dateValue.endsWith("Z") || dateValue.includes("+")
      ? dateValue
      : `${dateValue}Z`;

  return new Date(normalized).toLocaleString("he-IL", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}