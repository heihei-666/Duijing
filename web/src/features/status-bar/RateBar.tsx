import { cn } from '@/lib/cn';
import { rateColor, ratePercent } from '@/lib/rateColor';

interface RateBarProps {
  /** 近 30 天撑住率，0–100 */
  rate: number;
  className?: string;
}

/** 撑住率横向进度条（配色方案 四：用横向条，不用环形，列表里更好扫视） */
export function RateBar({ rate, className }: RateBarProps) {
  const percent = ratePercent(rate);

  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-inset', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={`近 30 天撑住率 ${percent}%`}
    >
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${percent}%`, backgroundColor: rateColor(rate) }}
      />
    </div>
  );
}
