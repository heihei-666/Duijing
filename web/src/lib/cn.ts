/** 拼 className，过滤掉 false / null / undefined */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}
