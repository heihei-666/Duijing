/**
 * 日期展示工具。
 *
 * 契约约定（API.md 0.3）：
 *   - 时间戳：ISO 8601 UTC 字符串，如 2026-09-26T14:30:00Z
 *   - 「日期」：本地时区（Asia/Shanghai）的 YYYY-MM-DD，由服务端判定「今天」
 * 因此这里的函数**只做展示格式化**，不做任何时区换算或「今天」判定，
 * 避免前端与服务端对不齐。
 */

/** "2026-09-26" → "9/26"；解析失败时原样返回 */
export function formatMonthDay(date: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!matched) return date;
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  return `${month}/${day}`;
}

/** "2026-09-26" + "周六" → "9/26 周六" */
export function formatDateWithWeekday(date: string, weekday: string): string {
  const monthDay = formatMonthDay(date);
  return weekday ? `${monthDay} ${weekday}` : monthDay;
}

/** ISO 时间戳 → 本地 "9/26 14:30"；解析失败时返回空串 */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  const month = parsed.getMonth() + 1;
  const day = parsed.getDate();
  const hour = String(parsed.getHours()).padStart(2, '0');
  const minute = String(parsed.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hour}:${minute}`;
}
