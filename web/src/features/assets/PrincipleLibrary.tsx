import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { Field } from '@/components/common/Field';
import { cn } from '@/lib/cn';
import { LinkIcon, PinIcon } from '@/features/weakness/icons';
import {
  confirmPrinciple,
  createPrinciple,
  ignorePrinciple,
  listPrinciples,
  PRINCIPLE_CONFIDENCE_LABELS,
  PRINCIPLE_SOURCE_LABELS,
  updatePrinciple,
  type PrincipleData,
} from '@/features/assets/api';
import { LoopPickerSheet } from '@/features/assets/LoopPickerSheet';

/**
 * 原则库（方案 3.6 / 配色方案 八）。
 * 候选：--sticky-observing-bg 暖黄底（和弱点「观察中」一致，都是待处理）；
 * 启用中：白底暖黑字；置顶用主色图钉；来源标签用 --info-light 底 + --info 字。
 * 候选不消失、不设 24 小时限制；忽略留痕，AI 不再重复推同一条。
 */
export function PrincipleLibrary() {
  const [principles, setPrinciples] = useState<PrincipleData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [content, setContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [picker, setPicker] = useState<PrincipleData | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await listPrinciples(['candidate', 'active']);
      setPrinciples(data.principles);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '原则库加载失败');
      setPrinciples([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    const trimmed = content.trim();
    if (!trimmed) {
      setError('先写一句原则');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      await createPrinciple({ content: trimmed });
      setContent('');
      setNotice('已新建，手动新建的原则直接启用');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新建失败，请稍后再试');
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirm(item: PrincipleData) {
    setBusyId(item.id);
    setError(null);
    try {
      await confirmPrinciple(item.id);
      setNotice('已启用');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
    } finally {
      setBusyId(null);
    }
  }

  async function handleIgnore(item: PrincipleData) {
    setBusyId(item.id);
    setError(null);
    try {
      await ignorePrinciple(item.id);
      setNotice('已忽略，AI 不会再推这一条');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
    } finally {
      setBusyId(null);
    }
  }

  async function handlePin(item: PrincipleData) {
    setBusyId(item.id);
    setError(null);
    try {
      await updatePrinciple(item.id, { pinned: !item.pinned });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
    } finally {
      setBusyId(null);
    }
  }

  const candidates = principles?.filter((item) => item.status === 'candidate') ?? [];
  const active = principles?.filter((item) => item.status === 'active') ?? [];

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-tertiary">
        撑住率达标后会生成候选。原则不催你，放着也不会消失。
      </p>

      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field
            label="新建原则"
            placeholder="一句话，例如：先承认，再补充"
            maxLength={200}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </div>
        <Button className="mb-0.5" loading={creating} disabled={creating} onClick={() => void handleCreate()}>
          新建
        </Button>
      </div>

      {notice ? <p className="text-xs text-tertiary">{notice}</p> : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}

      {principles === null ? (
        <p className="py-4 text-center text-[13px] text-tertiary">正在读取…</p>
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="text-[13px] text-secondary">
              候选 <span className="text-tertiary">{candidates.length}</span>
            </h3>

            {candidates.length === 0 ? (
              <EmptyState title="没有候选原则" hint="回环撑住率达标后，这里会出现候选。" />
            ) : (
              <ul className="space-y-2.5">
                {candidates.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-xl bg-sticky-observing px-4 py-3 text-sticky-observing"
                  >
                    <p className="text-[15px] leading-snug">{item.content}</p>
                    <PrincipleMeta item={item} />
                    <div className="mt-2 flex gap-2">
                      <Button
                        variant="outline"
                        className="border-success text-success hover:bg-success-light"
                        loading={busyId === item.id}
                        disabled={busyId !== null}
                        onClick={() => void handleConfirm(item)}
                      >
                        确认
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-tertiary hover:bg-surface"
                        disabled={busyId !== null}
                        onClick={() => void handleIgnore(item)}
                      >
                        忽略
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-[13px] text-secondary">
              启用中 <span className="text-tertiary">{active.length}</span>
            </h3>

            {active.length === 0 ? (
              <EmptyState title="还没有启用的原则" />
            ) : (
              <ul className="space-y-2.5">
                {active.map((item) => (
                  <li key={item.id} className="rounded-xl border border-light bg-surface px-4 py-3">
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 text-[15px] leading-snug text-primary">
                        {item.content}
                      </p>
                      {item.pinned ? (
                        <PinIcon className="mt-0.5 shrink-0 text-brand" />
                      ) : null}
                    </div>
                    <PrincipleMeta item={item} />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className={cn(item.pinned ? 'text-brand' : 'text-tertiary')}
                        disabled={busyId !== null}
                        onClick={() => void handlePin(item)}
                      >
                        {item.pinned ? '取消置顶' : '置顶'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-tertiary"
                        onClick={() => setPicker(item)}
                      >
                        <LinkIcon width={16} height={16} />
                        关联回环
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {picker ? (
        <LoopPickerSheet
          principle={picker}
          onClose={() => setPicker(null)}
          onSaved={(message) => {
            setNotice(message);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/** 来源标签（--info-light 底 + --info 字）+ 置信度 + 已关联的回环 */
function PrincipleMeta({ item }: { item: PrincipleData }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="rounded-md bg-info-light px-1.5 py-0.5 text-[10px] leading-4 text-info">
        {PRINCIPLE_SOURCE_LABELS[item.source_type] ?? item.source_type}
      </span>
      <span className="text-[10px] leading-4 opacity-70">
        置信度 {PRINCIPLE_CONFIDENCE_LABELS[item.confidence] ?? item.confidence}
      </span>
      {item.linked_loops.length > 0 ? (
        <span className="min-w-0 truncate text-[10px] leading-4 opacity-70">
          关联：{item.linked_loops.map((loop) => loop.trigger_scene).join('、')}
        </span>
      ) : null}
    </div>
  );
}
