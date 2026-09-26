import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { WeaknessStatus } from '@/api/types';
import { Button } from '@/components/common/Button';
import { cn } from '@/lib/cn';
import { ChevronDownIcon, PlusIcon, TrashIcon } from '@/features/weakness/icons';
import { TrashSheet } from '@/features/weakness/TrashSheet';
import { WeaknessActionsSheet } from '@/features/weakness/WeaknessActionsSheet';
import { WeaknessFormSheet } from '@/features/weakness/WeaknessFormSheet';
import { WeaknessNote } from '@/features/weakness/WeaknessNote';
import { WeaknessSection } from '@/features/weakness/WeaknessSection';
import {
  listWeaknesses,
  type WeaknessCardData,
  type WeaknessGroupsData,
} from '@/features/weakness/api';

/** 四区一次取全：前端分区渲染，暂存区的倒计时也直接从这份数据来 */
const STATUS_FILTER: WeaknessStatus[] = ['ai_candidate', 'observing', 'improving', 'archived'];

interface SectionSpec {
  status: WeaknessStatus;
  title: string;
  emptyTitle: string;
  emptyHint?: string;
  defaultOpen: boolean;
}

const SECTIONS: SectionSpec[] = [
  {
    status: 'ai_candidate',
    title: 'AI 观察候选',
    // 这一区大部分时候是空的，文案克制，不催
    emptyTitle: '暂时没有新的观察',
    emptyHint: '辩一轮，或记几笔事件卡。',
    defaultOpen: true,
  },
  {
    status: 'observing',
    title: '观察中',
    emptyTitle: '还没有在观察的弱点',
    emptyHint: '把 AI 候选加入观察，或自己新建一条。',
    defaultOpen: true,
  },
  {
    status: 'improving',
    title: '改善中',
    emptyTitle: '还没有在改善的弱点',
    emptyHint: '给弱点建一条回环，它就会进到这里。',
    defaultOpen: true,
  },
  {
    status: 'archived',
    title: '暂存',
    emptyTitle: '暂存区是空的',
    emptyHint: '移入暂存的弱点在这里放 60 天。',
    defaultOpen: false,
  },
];

/**
 * 弱点墙（方案 3.2）。
 * 四区：AI 观察候选 / 观察中 / 改善中 / 暂存。移动端列表态，分区可折叠，长按便签改状态。
 */
export default function WeaknessesPage() {
  const navigate = useNavigate();

  const [data, setData] = useState<WeaknessGroupsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [actionCard, setActionCard] = useState<WeaknessCardData | null>(null);
  const [justCreatedId, setJustCreatedId] = useState<number | null>(null);

  /** silent = 后台刷新，不切成骨架屏（改完状态后用） */
  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      setData(await listWeaknesses(STATUS_FILTER));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '弱点加载失败';
      if (silent) {
        setNotice(message);
        setNoticeError(true);
      } else {
        setError(message);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function flash(message: string, isError = false) {
    setNotice(message);
    setNoticeError(isError);
  }

  async function handleActionDone(message: string) {
    setActionCard(null);
    flash(message);
    await load(true);
  }

  async function handleRestored(message: string) {
    flash(message);
    await load(true);
  }

  if (loading) return <WeaknessSkeleton />;

  if (error || !data) {
    return (
      <div className="rounded-2xl border border-light bg-surface p-6 text-center shadow-card">
        <p className="text-[13px] text-secondary">{error ?? '弱点加载失败'}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-medium text-primary">弱点</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-secondary">
            先让它显形，再一条条练过去。
          </p>
        </div>
        <Button size="sm" className="mt-0.5" onClick={() => setCreateOpen(true)}>
          <PlusIcon width={16} height={16} />
          新建弱点
        </Button>
      </header>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => navigate('/assets?tab=events')}
          className="flex h-11 flex-1 items-center justify-center rounded-xl bg-elevated text-[13px] text-primary transition-colors hover:bg-inset"
        >
          + 记一笔
        </button>
        <button
          type="button"
          onClick={() => setTrashOpen(true)}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-elevated text-[13px] text-secondary transition-colors hover:bg-inset"
        >
          <TrashIcon width={16} height={16} />
          垃圾桶
        </button>
      </div>

      {notice ? (
        <p className={cn('text-xs', noticeError ? 'text-danger' : 'text-tertiary')}>{notice}</p>
      ) : null}

      <div className="space-y-4">
        {SECTIONS.map((section) => {
          const cards = data.groups[section.status] ?? [];
          return (
            <WeaknessSection
              key={section.status}
              title={section.title}
              count={cards.length}
              emptyTitle={section.emptyTitle}
              emptyHint={section.emptyHint}
              defaultOpen={section.defaultOpen}
            >
              {cards.map((card) => (
                <WeaknessNote
                  key={card.id}
                  card={card}
                  highlighted={card.id === justCreatedId}
                  onOpen={(item) => navigate(`/weaknesses/${item.id}`)}
                  onAction={setActionCard}
                />
              ))}
            </WeaknessSection>
          );
        })}
      </div>

      {data.groups.archived && data.groups.archived.length > 0 ? (
        <button
          type="button"
          onClick={() => setTrashOpen(true)}
          className="flex w-full items-center gap-2 rounded-xl border border-light bg-surface px-4 py-3 text-left transition-colors hover:bg-elevated"
        >
          <TrashIcon width={16} height={16} className="text-tertiary" />
          <span className="flex-1 text-[13px] text-secondary">
            垃圾桶里有 {data.groups.archived.length} 条暂存的弱点
          </span>
          <ChevronDownIcon className="-rotate-90 text-tertiary" />
        </button>
      ) : null}

      <WeaknessFormSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={(card) => {
          setJustCreatedId(card.id);
          flash('已加入观察中');
          void load(true);
        }}
      />

      <TrashSheet
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onRestored={(message) => void handleRestored(message)}
      />

      {actionCard ? (
        <WeaknessActionsSheet
          card={actionCard}
          onClose={() => setActionCard(null)}
          onDone={(message) => void handleActionDone(message)}
          onOpenDetail={(card) => {
            setActionCard(null);
            navigate(`/weaknesses/${card.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

/** 骨架屏：只用中性底色，不闪彩色 */
function WeaknessSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="h-6 w-28 animate-pulse rounded bg-elevated" />
      <div className="h-11 animate-pulse rounded-xl bg-elevated" />
      <div className="h-24 animate-pulse rounded-xl bg-elevated" />
      <div className="h-24 animate-pulse rounded-xl bg-elevated" />
      <div className="h-24 animate-pulse rounded-xl bg-elevated" />
    </div>
  );
}
