/** Display a Feishu date timestamp using the field's configured date formatter. */
export function formatFeishuDate(value: unknown, pattern?: string): string {
  if (value === undefined || value === null || value === "") return "未填写";
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "无效日期";
  if (!pattern)
    return date.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    });
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (key: string) =>
    parts.find((part) => part.type === key)?.value || "";
  const values: Record<string, string> = {
    yyyy: get("year"),
    yy: get("year").slice(-2),
    MM: get("month"),
    M: String(Number(get("month"))),
    dd: get("day"),
    d: String(Number(get("day"))),
    HH: get("hour"),
    H: String(Number(get("hour"))),
    mm: get("minute"),
    m: String(Number(get("minute"))),
    ss: get("second"),
    s: String(Number(get("second"))),
  };
  return pattern.replace(
    /yyyy|yy|MM|dd|HH|mm|ss|M|d|H|m|s/g,
    (token) => values[token],
  );
}
