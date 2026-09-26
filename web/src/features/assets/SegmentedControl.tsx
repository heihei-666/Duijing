import { cn } from '@/lib/cn';

export interface Segment<T extends string> {
  key: T;
  label: string;
  /** 右上角的小计数（待确认 / 候选数量），0 不显示 */
  badge?: number;
}

interface SegmentedControlProps<T extends string> {
  segments: Array<Segment<T>>;
  value: T;
  onChange: (key: T) => void;
}

/** 分段控件：资产页四个分区用它切换。触控目标 44px，选中态只用明度差，不加彩色。 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div role="tablist" className="flex gap-1 rounded-xl bg-elevated p-1">
      {segments.map((segment) => {
        const active = segment.key === value;
        return (
          <button
            key={segment.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(segment.key)}
            className={cn(
              'flex h-11 flex-1 items-center justify-center gap-1 rounded-lg text-[13px] transition-colors',
              active ? 'bg-surface text-primary shadow-card' : 'text-secondary hover:text-primary',
            )}
          >
            <span className="truncate">{segment.label}</span>
            {typeof segment.badge === 'number' && segment.badge > 0 ? (
              <span
                className={cn(
                  'rounded-md px-1 text-[10px] tabular-nums',
                  active ? 'bg-elevated text-secondary' : 'bg-surface text-tertiary',
                )}
              >
                {segment.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
