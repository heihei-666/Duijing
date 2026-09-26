import { cn } from '@/lib/cn';
import { rateAriaLabel, rateColor, ratePercent } from '@/lib/rateColor';

interface RateBarProps {
  /** 近 30 天撑住率，0–100；null 表示还没有触发记录 */
  rate: number | null;
  className?: string;
}

/**
 * 撑住率横向进度条（配色方案 四：用横向条，不用环形，列表里更好扫视）。
 *
 * 没有数据（null）时只画空槽：轨道用中性的 --bg-inset，不填充、不取 --rate-low。
 * 空槽 + 「--」是「还没练过」，红色 0% 是「每次都破功」，两者不能画成一样。
 */
export function RateBar({ rate, className }: RateBarProps) {
  const percent = ratePercent(rate);
  const empty = percent === null;

  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-inset', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={empty ? undefined : percent}
      aria-label={rateAriaLabel(rate)}
    >
      {empty ? null : (
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${percent}%`, backgroundColor: rateColor(rate) }}
        />
      )}
    </div>
  );
}
