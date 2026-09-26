import { cn } from '@/lib/cn';
import { RateBar } from '@/features/status-bar/RateBar';
import { rateColor, ratePercent } from '@/lib/rateColor';

interface RateMeterProps {
  rate: number;
  holdCount: number;
  triggerCount: number;
  className?: string;
}

/**
 * 撑住率一行（方案 3.3 / 配色方案 四）。
 * 横向进度条，不用环形——横向条在列表里更容易扫视。
 * 文案固定为「近 30 天：撑住 N / 触发 N = N%」，与方案原文逐字一致。
 */
export function RateMeter({ rate, holdCount, triggerCount, className }: RateMeterProps) {
  const percent = ratePercent(rate);

  return (
    <div className={cn('space-y-1.5', className)}>
      <p className="text-[11px] leading-4 text-tertiary">
        近 30 天：撑住 {holdCount} / 触发 {triggerCount} ={' '}
        <span className="font-medium tabular-nums" style={{ color: rateColor(rate) }}>
          {percent}%
        </span>
      </p>
      <RateBar rate={rate} />
    </div>
  );
}
