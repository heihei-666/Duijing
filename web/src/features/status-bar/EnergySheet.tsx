import { useEffect, useState } from 'react';

import { Button } from '@/components/common/Button';
import { Sheet } from '@/components/common/Sheet';

interface EnergySheetProps {
  open: boolean;
  /** 当前值，null 表示今天还没填 */
  value: number | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (energy: number) => void;
}

/** 未填过时的起始值：取中间，不替用户表态 */
const DEFAULT_ENERGY = 50;

/** 精力滑块（0–100），写在底部抽屉里，不跳页、不打断首页 */
export function EnergySheet({
  open,
  value,
  saving,
  error,
  onClose,
  onSubmit,
}: EnergySheetProps) {
  const [draft, setDraft] = useState<number>(value ?? DEFAULT_ENERGY);

  // 每次打开时同步成服务端的当前值
  useEffect(() => {
    if (open) setDraft(value ?? DEFAULT_ENERGY);
  }, [open, value]);

  return (
    <Sheet
      open={open}
      title="今天的精力"
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <Button variant="outline" fullWidth onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button fullWidth loading={saving} onClick={() => onSubmit(draft)}>
            保存
          </Button>
        </div>
      }
    >
      <div className="flex items-baseline justify-center gap-1">
        <span className="text-3xl font-medium tabular-nums text-primary">{draft}</span>
        <span className="text-xs text-tertiary">/ 100</span>
      </div>

      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
        aria-label="今天的精力"
        className="dj-range mt-5"
      />
      <div className="mt-1.5 flex justify-between text-[11px] text-tertiary">
        <span>0</span>
        <span>100</span>
      </div>

      <p className="mt-4 text-xs text-tertiary">可以不填，不填就不显示。随时能改。</p>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </Sheet>
  );
}
