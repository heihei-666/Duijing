import { useEffect, useState } from 'react';

import { cn } from '@/lib/cn';
import {
  listAdvantages,
  listPrinciples,
  type AdvantageData,
  type PrincipleData,
} from '@/features/assets/api';

/** 回环里引用的优势 / 原则 id（提交时映射为 linked_advantage_ids / linked_principle_ids） */
export interface LoopAssetSelection {
  advantageIds: number[];
  principleIds: number[];
}

export const EMPTY_LOOP_ASSETS: LoopAssetSelection = { advantageIds: [], principleIds: [] };

interface LoopAssetPickerProps {
  value: LoopAssetSelection;
  onChange: (next: LoopAssetSelection) => void;
  disabled?: boolean;
}

/**
 * 表单式回环的「引用优势 / 原则」多选（方案 3.3：应对预案可从优势库、原则库引用）。
 *
 * 只列**已确认的优势**（status=confirmed）和**已启用的原则**（status=active）——
 * 方案 3.5：「已确认的优势才在回环预案中被推荐」。
 * 待确认 / 候选的东西不在这里出现，否则等于绕过确认这一步。
 *
 * 两块都为空时整块不渲染：空的复选区只占地方，什么也说明不了。
 * 拉取失败时只留一句极淡的说明，不挡住「保存回环」——引用是可选步骤。
 *
 * 只用在 LoopCreateSheet 的**表单 tab**；对话式三步不收集引用。
 */
export function LoopAssetPicker({ value, onChange, disabled = false }: LoopAssetPickerProps) {
  const [advantages, setAdvantages] = useState<AdvantageData[]>([]);
  const [principles, setPrinciples] = useState<PrincipleData[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [advantageData, principleData] = await Promise.all([
          listAdvantages(['confirmed']),
          listPrinciples(['active']),
        ]);
        if (cancelled) return;
        setAdvantages(advantageData.advantages);
        setPrinciples(principleData.principles);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(kind: keyof LoopAssetSelection, id: number) {
    const current = value[kind];
    onChange({
      ...value,
      [kind]: current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    });
  }

  if (!loaded) return null;

  if (failed) {
    return <p className="text-xs text-tertiary">优势和原则暂时读取不到，不引用也能保存。</p>;
  }

  if (advantages.length === 0 && principles.length === 0) return null;

  return (
    <div className="space-y-3">
      {advantages.length > 0 ? (
        <AssetChipGroup
          label="可引用的优势"
          options={advantages.map((item) => ({ id: item.id, text: item.name }))}
          selected={value.advantageIds}
          disabled={disabled}
          onToggle={(id) => toggle('advantageIds', id)}
        />
      ) : null}

      {principles.length > 0 ? (
        <AssetChipGroup
          label="可引用的原则"
          options={principles.map((item) => ({ id: item.id, text: item.content }))}
          selected={value.principleIds}
          disabled={disabled}
          onToggle={(id) => toggle('principleIds', id)}
        />
      ) : null}
    </div>
  );
}

interface AssetChipGroupProps {
  label: string;
  options: Array<{ id: number; text: string }>;
  selected: number[];
  disabled: boolean;
  onToggle: (id: number) => void;
}

/**
 * 一组多选 chip。
 * 交互与样式对齐 LoopPickerSheet（同样的 checkbox 方块 + 选中态 --primary / --primary-light），
 * 只是这里不用进抽屉，直接铺在表单里；每项 min-h 44px。
 */
function AssetChipGroup({ label, options, selected, disabled, onToggle }: AssetChipGroupProps) {
  return (
    <div className="space-y-1.5">
      <p className="text-[13px] text-secondary">
        {label}
        {selected.length > 0 ? (
          <span className="ml-1.5 text-tertiary">已选 {selected.length}</span>
        ) : null}
      </p>

      <ul className="max-h-44 space-y-2 overflow-y-auto pr-1">
        {options.map((option) => {
          const active = selected.includes(option.id);
          return (
            <li key={option.id}>
              <button
                type="button"
                aria-pressed={active}
                disabled={disabled}
                onClick={() => onToggle(option.id)}
                className={cn(
                  'flex min-h-[44px] w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors',
                  active
                    ? 'border-primary bg-primary-light'
                    : 'border-light bg-surface hover:bg-elevated',
                  disabled && 'opacity-50',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]',
                    active ? 'border-primary bg-primary text-on-brand' : 'border-strong',
                  )}
                >
                  {active ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1 text-[14px] leading-snug text-primary">
                  {option.text}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
