import { useEffect, useState } from 'react';

import { eventCardApi } from '@/api/client';
import { Button } from '@/components/common/Button';
import { Sheet } from '@/components/common/Sheet';
import { TextAreaField } from '@/features/weakness/TextAreaField';

interface QuickEventCardSheetProps {
  open: boolean;
  onClose: () => void;
  /** 记成功后通知首页静默刷新（可能已经自动关联到回环、写了日志） */
  onSaved: () => void;
}

/**
 * 「记一笔」极简事件卡（首页 Cold start 改造 · 任务 3）。
 *
 * 只问一句话：POST /api/event-cards，body 只有 `{ content }`，
 * 关联与结果判断全部交给 AI，用户不需要在任何下拉框里做选择。
 * 交互与资产页的 EventCardHistory 保持一致（同样一句 placeholder、同样不弹窗），
 * 只是把它搬到了首页，省掉「进资产页 → 找到事件卡分区」这两步。
 *
 * 保存成功后不弹 alert、不打断：留在 Sheet 里给一句温和的说明，点「完成」退出。
 */
export function QuickEventCardSheet({ open, onClose, onSaved }: QuickEventCardSheetProps) {
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** null = 还在填；否则是保存结果，用来决定要不要多说一句「已经关联上了」 */
  const [linked, setLinked] = useState<boolean | null>(null);

  // 每次打开都是干净的一张空卡
  useEffect(() => {
    if (!open) return;
    setContent('');
    setSaving(false);
    setError(null);
    setLinked(null);
  }, [open]);

  async function save() {
    const trimmed = content.trim();
    if (trimmed === '' || saving) return;

    setSaving(true);
    setError(null);
    try {
      const result = await eventCardApi.create({ content: trimmed });
      setLinked(result.auto_linked);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后再试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} title="记一笔" onClose={onClose}>
      {linked === null ? (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-secondary">
            一句话就够，不用写前因后果。
          </p>

          <TextAreaField
            aria-label="刚才发生了什么"
            placeholder="刚才发生了什么？一句话就够。"
            rows={3}
            maxLength={1000}
            autoFocus
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />

          {error ? <p className="text-xs text-danger">{error}</p> : null}

          <Button
            fullWidth
            loading={saving}
            disabled={saving || content.trim() === ''}
            onClick={() => void save()}
          >
            保存
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[15px] text-primary">记下了。</p>
          <p className="text-[13px] leading-relaxed text-secondary">
            AI 稍后会帮你判断关联和结果，不用你操心。
          </p>
          {linked ? <p className="text-xs text-tertiary">这一笔已经挂到你正在练的回环上了。</p> : null}
          <Button fullWidth variant="outline" onClick={onClose}>
            完成
          </Button>
        </div>
      )}
    </Sheet>
  );
}
