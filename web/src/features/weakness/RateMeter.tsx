import { cn } from '@/lib/cn';
import { RateBar } from '@/features/status-bar/RateBar';
import { rateColor, ratePercent, rateText, RATE_EMPTY_NOTE } from '@/lib/rateColor';

interface RateMeterProps {
  /** 近 30 天撑住率，0–100；null 表示还没有触发记录（不是 0%） */
  rate: number | null;
  holdCount: number;
  triggerCount: number;
  className?: string;
}

/**
 * 撑住率一行（方案 3.3 / 配色方案 四）。
 * 横向进度条，不用环形——横向条在列表里更容易扫视。
 * 有数据时文案固定为「近 30 天：撑住 N / 触发 N = N%」，与方案原文逐字一致。
 *
 * 还没有触发记录（rate 为 null）时：数字显示 `--`（中性色，不是砖红 0%），
 * 并跟一句「还没有记录」——新回环一次都没练过，不该被显示成持续失败。
 */
export function RateMeter({ rate, holdCount, triggerCount, className }: RateMeterProps) {
  const percent = ratePercent(rate);

  return (
    <div className={cn('space-y-1.5', className)}>
      <p className="text-[11px] leading-4 text-tertiary">
        近 30 天：撑住 {holdCount} / 触发 {triggerCount} ={' '}
        <span className="font-medium tabular-nums" style={{ color: rateColor(rate) }}>
          {rateText(rate)}
        </span>
        {percent === null ? <span className="ml-1.5">{RATE_EMPTY_NOTE}</span> : null}
      </p>
      <RateBar rate={rate} />
    </div>
  );
}
