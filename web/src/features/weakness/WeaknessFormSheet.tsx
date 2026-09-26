import { useEffect, useState } from 'react';

import { cn } from '@/lib/cn';
import type { WeaknessDomain } from '@/api/types';
import { Button } from '@/components/common/Button';
import { Field } from '@/components/common/Field';
import { Sheet } from '@/components/common/Sheet';
import {
  createWeakness,
  DOMAIN_LABELS,
  DOMAIN_ORDER,
  updateWeakness,
  type WeaknessCardData,
} from '@/features/weakness/api';
import { ConfidenceStars } from '@/features/weakness/MetaTags';
import { TextAreaField } from '@/features/weakness/TextAreaField';

interface WeaknessFormSheetProps {
  open: boolean;
  onClose: () => void;
  /** 传了就是编辑（PATCH），不传就是新建（POST） */
  card?: WeaknessCardData | null;
  /** 保存成功后把最新卡片交给调用方（新建时用来高亮新便签） */
  onSaved: (card: WeaknessCardData) => void;
}

/**
 * 新建 / 编辑弱点（POST /api/weaknesses、PATCH /api/weaknesses/{id}）。
 * 必填：名称、描述、影响领域；置信度 1–5 星，默认 3。
 * 状态不在这里改——四区流转走便签的长按面板。
 */
export function WeaknessFormSheet({ open, onClose, card = null, onSaved }: WeaknessFormSheetProps) {
  const editing = card !== null;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [domains, setDomains] = useState<WeaknessDomain[]>([]);
  const [confidence, setConfidence] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时用最新数据回填（编辑态）；关闭后清空，避免下次打开看到上一次的残留
  useEffect(() => {
    if (!open) return;
    setName(card?.name ?? '');
    setDescription(card?.description ?? '');
    setDomains(card?.domains ?? []);
    setConfidence(card?.confidence ?? 3);
    setError(null);
    setSubmitting(false);
  }, [open, card]);

  function handleClose() {
    if (submitting) return;
    onClose();
  }

  function toggleDomain(domain: WeaknessDomain) {
    setDomains((current) =>
      current.includes(domain) ? current.filter((item) => item !== domain) : [...current, domain],
    );
  }

  async function handleSubmit() {
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();

    if (!trimmedName) {
      setError('先给这个弱点起个名字');
      return;
    }
    if (!trimmedDescription) {
      setError('再写一句它通常是什么样子');
      return;
    }
    if (domains.length === 0) {
      setError('至少选一个影响领域');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        name: trimmedName,
        description: trimmedDescription,
        domains,
        confidence,
      };
      const result = editing
        ? await updateWeakness(card.id, payload)
        : await createWeakness(payload);
      onSaved(result.weakness);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后再试');
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      title={editing ? '编辑弱点' : '新建弱点'}
      onClose={handleClose}
      footer={
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={handleClose} disabled={submitting}>
            取消
          </Button>
          <Button className="flex-1" loading={submitting} onClick={() => void handleSubmit()}>
            保存
          </Button>
        </div>
      }
    >
      <div className="max-h-[58vh] space-y-4 overflow-y-auto pb-2">
        <Field
          label="名称"
          placeholder="例如：被追问时防御性重复"
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />

        <TextAreaField
          label="描述"
          placeholder="它通常怎么出现？举一个最近的例子。"
          rows={3}
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />

        <div className="space-y-1.5">
          <p className="text-[13px] text-secondary">影响领域</p>
          <ul className="flex flex-wrap gap-2">
            {DOMAIN_ORDER.map((domain) => {
              const selected = domains.includes(domain);
              return (
                <li key={domain}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleDomain(domain)}
                    className={cn(
                      'flex min-h-[44px] items-center rounded-xl border px-3 text-[13px] transition-colors',
                      selected
                        ? 'border-primary bg-primary-light text-brand'
                        : 'border-light bg-surface text-secondary hover:bg-elevated',
                    )}
                  >
                    {DOMAIN_LABELS[domain]}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="space-y-1">
          <p className="text-[13px] text-secondary">置信度</p>
          <ConfidenceStars value={confidence} onChange={setConfidence} />
          <p className="text-xs text-tertiary">不确定就留在 3 星，之后可以改。</p>
        </div>

        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    </Sheet>
  );
}
