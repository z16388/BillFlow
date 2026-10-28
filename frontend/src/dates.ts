// China billing dates use the same timezone regardless of the browser's locale.
export function todayString(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
export function dateRange(preset: string, now = new Date()): [string, string] {
  const end = todayString(now);
  if (preset === "all") return ["", ""];
  if (preset === "month") return [end.slice(0, 7) + "-01", end];
  const [y, m, d] = end.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  if (preset === "seven") start.setUTCDate(start.getUTCDate() - 6);
  else {
    // Rolling calendar months, clamping month-end (e.g. March 31 → Feb 28).
    const target = new Date(
      Date.UTC(y, m - 1 - (preset === "three" ? 3 : 1), 1),
    );
    const last = new Date(
      Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
    ).getUTCDate();
    start.setUTCFullYear(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      Math.min(d, last),
    );
  }
  return [start.toISOString().slice(0, 10), end];
}
