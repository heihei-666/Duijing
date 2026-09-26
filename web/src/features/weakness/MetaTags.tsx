import { cn } from '@/lib/cn';
import type { WeaknessDomain } from '@/api/types';
import { DOMAIN_LABELS } from '@/features/weakness/api';
import { StarIcon } from '@/features/weakness/icons';

/** 领域标签（只读）：中性色，不用彩色——领域不是状态 */
export function DomainTags({
  domains,
  className,
}: {
  domains: WeaknessDomain[];
  className?: string;
}) {
  if (domains.length === 0) return null;

  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)}>
      {domains.map((domain) => (
        <li
          key={domain}
          className="rounded-md bg-elevated px-2 py-0.5 text-[11px] leading-5 text-secondary"
        >
          {DOMAIN_LABELS[domain] ?? domain}
        </li>
      ))}
    </ul>
  );
}

interface ConfidenceStarsProps {
  /** 1–5 */
  value: number;
  /** 传了就是可编辑（≥44px 触控目标），不传是只读 */
  onChange?: (value: number) => void;
  className?: string;
}

/**
 * 置信度星级（方案 3.2：1–5 星，默认 3）。
 * 用主色而不是金色——配色方案第十一章第 6 条：不用金色、奖杯色、游戏化色。
 */
export function ConfidenceStars({ value, onChange, className }: ConfidenceStarsProps) {
  const editable = typeof onChange === 'function';
  const stars = [1, 2, 3, 4, 5];

  if (!editable) {
    return (
      <span
        className={cn('inline-flex items-center gap-0.5', className)}
        aria-label={`置信度 ${value} 星`}
      >
        {stars.map((star) => (
          <StarIcon
            key={star}
            width={13}
            height={13}
            className={star <= value ? 'text-brand' : 'text-disabled'}
          />
        ))}
      </span>
    );
  }

  return (
    <div className={cn('flex items-center gap-1', className)} role="radiogroup" aria-label="置信度">
      {stars.map((star) => (
        <button
          key={star}
          type="button"
          role="radio"
          aria-checked={star === value}
          aria-label={`${star} 星`}
          onClick={() => onChange?.(star)}
          className="flex h-11 w-9 items-center justify-center rounded-lg hover:bg-elevated"
        >
          <StarIcon
            width={18}
            height={18}
            className={star <= value ? 'text-brand' : 'text-disabled'}
          />
        </button>
      ))}
      <span className="ml-1 text-[13px] text-tertiary">{value} 星</span>
    </div>
  );
}
