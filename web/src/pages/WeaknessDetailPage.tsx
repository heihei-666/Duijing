import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { CloseIcon } from '@/components/icons';
import { cn } from '@/lib/cn';
import { LoopCard } from '@/features/weakness/LoopCard';
import { LoopCreateSheet } from '@/features/weakness/LoopCreateSheet';
import { ConfidenceStars, DomainTags } from '@/features/weakness/MetaTags';
import { RateMeter } from '@/features/weakness/RateMeter';
import { RecordLogSheet } from '@/features/weakness/RecordLogSheet';
import { WeaknessFormSheet } from '@/features/weakness/WeaknessFormSheet';
import { PlusIcon } from '@/features/weakness/icons';
import {
  archiveWeakness,
  getWeakness,
  restoreWeakness,
  SOURCE_LABELS,
  WEAKNESS_STATUS_LABELS,
  type LoopData,
  type WeaknessDetailData,
} from '@/features/weakness/api';

/**
 * 弱点详情（GET /api/weaknesses/{id}）。
 * 三块：弱点信息 + 撑住率横向条 / 回环列表（含演练日志）/ 降级提示。
 * 首页「今天练什么」会带 ?loop=<loop_id> 跳进来，这里负责高亮并滚到那条回环。
 */
export default function WeaknessDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const weaknessId = Number(id);
  const focusLoopId = Number(searchParams.get('loop') ?? '') || null;

  const [detail, setDetail] = useState<WeaknessDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState(false);

  const [downgradeDismissed, setDowngradeDismissed] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [createLoopOpen, setCreateLoopOpen] = useState(false);
  const [recordLoop, setRecordLoop] = useState<LoopData | null>(null);
  const [logsKey, setLogsKey] = useState(0);
  const [highlightLoopId, setHighlightLoopId] = useState<number | null>(focusLoopId);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const data = await getWeakness(weaknessId);
        setDetail(data);
        return data;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '弱点加载失败';
        if (silent) {
          flash(message, true);
        } else {
          setError(message);
        }
        return null;
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [weaknessId],
  );

  useEffect(() => {
    if (!Number.isFinite(weaknessId)) {
      setError('弱点编号不正确');
      setLoading(false);
      return;
    }
    void load();
  }, [load, weaknessId]);

  // ?loop=<id> 时滚到那条回环（首页跳转约定）
  useEffect(() => {
    if (!detail || !focusLoopId) return;
    const node = document.getElementById(`loop-${focusLoopId}`);
    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [detail, focusLoopId]);

  function flash(message: string, isError = false) {
    setNotice(message);
    setNoticeError(isError);
  }

  async function handleArchive() {
    setArchiveBusy(true);
    try {
      const result = await archiveWeakness(weaknessId);
      setConfirmArchive(false);
      setDowngradeDismissed(true);
      flash(result.note ?? '已移入暂存');
      await load(true);
    } catch (cause) {
      flash(cause instanceof Error ? cause.message : '操作失败，请稍后再试', true);
    } finally {
      setArchiveBusy(false);
    }
  }

  async function handleRestore() {
    setArchiveBusy(true);
    try {
      await restoreWeakness(weaknessId);
      flash('已恢复为观察中');
      await load(true);
    } catch (cause) {
      flash(cause instanceof Error ? cause.message : '操作失败，请稍后再试', true);
    } finally {
      setArchiveBusy(false);
    }
  }

  if (loading) return <DetailSkeleton />;

  if (error || !detail) {
    return (
      <div className="space-y-4">
        <BackLink onBack={() => navigate('/weaknesses')} />
        <div className="rounded-2xl border border-light bg-surface p-6 text-center shadow-card">
          <p className="text-[13px] text-secondary">{error ?? '弱点不存在'}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
            重试
          </Button>
        </div>
      </div>
    );
  }

  const { weakness, loops, suggest_downgrade: suggestDowngrade, suggest_archive: suggestArchive } =
    detail;

  return (
    <div className="space-y-5">
      <BackLink onBack={() => navigate('/weaknesses')} />

      {suggestDowngrade && weakness.status !== 'archived' && !downgradeDismissed ? (
        <div className="rounded-xl bg-warning-light px-4 py-3">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-primary">
              这条弱点的撑住率已经达标，可以考虑降级为观察存档。
            </p>
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => setDowngradeDismissed(true)}
              className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-tertiary hover:bg-surface"
            >
              <CloseIcon width={16} height={16} />
            </button>
          </div>
          {confirmArchive ? (
            <div className="mt-2.5 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                loading={archiveBusy}
                disabled={archiveBusy}
                onClick={() => void handleArchive()}
              >
                确认移入暂存
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={archiveBusy}
                onClick={() => setConfirmArchive(false)}
              >
                取消
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="mt-2.5"
              onClick={() => setConfirmArchive(true)}
            >
              移入暂存
            </Button>
          )}
        </div>
      ) : null}

      <header className="space-y-3">
        <div className="flex items-start gap-3">
          <h1 className="min-w-0 flex-1 text-lg font-medium leading-snug text-primary">
            {weakness.name}
          </h1>
          <span className="mt-0.5 shrink-0 rounded-md bg-elevated px-2 py-0.5 text-[11px] leading-5 text-secondary">
            {WEAKNESS_STATUS_LABELS[weakness.status]}
          </span>
        </div>

        {weakness.description ? (
          <p className="text-[14px] leading-relaxed text-secondary">{weakness.description}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <DomainTags domains={weakness.domains} />
          <ConfidenceStars value={weakness.confidence} />
          <span className="text-[11px] text-tertiary">
            来源：{SOURCE_LABELS[weakness.source]} · {weakness.days_since_created} 天前建
          </span>
        </div>

        <RateMeter
          rate={weakness.hold_rate_30d}
          holdCount={weakness.hold_count_30d}
          triggerCount={weakness.trigger_count_30d}
        />

        {suggestArchive && weakness.trigger_count_30d === 0 && loops.length === 0 ? (
          <p className="text-xs text-tertiary">这条记录还没有触发过，可以先放观察存档。</p>
        ) : null}

        <div className="flex gap-2">
          <Button size="sm" variant="subtle" onClick={() => setEditOpen(true)}>
            编辑
          </Button>
          {weakness.status === 'archived' ? (
            <Button size="sm" variant="outline" loading={archiveBusy} onClick={() => void handleRestore()}>
              恢复
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={archiveBusy} onClick={() => setConfirmArchive(true)}>
              移入暂存
            </Button>
          )}
        </div>
      </header>

      {notice ? (
        <p className={cn('text-xs', noticeError ? 'text-danger' : 'text-tertiary')}>{notice}</p>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-[13px] text-secondary">回环</h2>
          <Button size="sm" onClick={() => setCreateLoopOpen(true)}>
            <PlusIcon width={16} height={16} />
            新建回环
          </Button>
        </div>

        {loops.length === 0 ? (
          <div className="rounded-2xl border border-light bg-surface shadow-card">
            <EmptyState
              title="还没有回环"
              hint="回环 = 触发场景 + 身体信号 + 应对预案。先建一条，练起来才有撑住率。"
            />
          </div>
        ) : (
          <div className="space-y-3">
            {loops.map((loop) => (
              <div key={loop.id} id={`loop-${loop.id}`}>
                <LoopCard
                  loop={loop}
                  highlighted={highlightLoopId === loop.id}
                  logsReloadKey={logsKey}
                  onChanged={(message) => {
                    flash(message);
                    void load(true);
                  }}
                  onRecord={setRecordLoop}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {createLoopOpen ? (
        <LoopCreateSheet
          weaknessId={weaknessId}
          weaknessName={weakness.name}
          onClose={() => setCreateLoopOpen(false)}
          onFinished={(message) => {
            setCreateLoopOpen(false);
            flash(message);
            void load(true).then((data) => {
              if (!data || data.loops.length === 0) return;
              setHighlightLoopId(Math.max(...data.loops.map((item) => item.id)));
            });
          }}
        />
      ) : null}

      {recordLoop ? (
        <RecordLogSheet
          loop={recordLoop}
          onClose={() => setRecordLoop(null)}
          onRecorded={() => {
            setLogsKey((value) => value + 1);
            void load(true);
          }}
          onConfirmDowngrade={async () => {
            await archiveWeakness(weaknessId);
            flash('已移入暂存');
            await load(true);
          }}
        />
      ) : null}

      <WeaknessFormSheet
        open={editOpen}
        card={weakness}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          flash('已保存');
          void load(true);
        }}
      />
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="-ml-1 flex h-11 items-center gap-1 rounded-lg px-1 text-[13px] text-secondary hover:text-primary"
    >
      <span aria-hidden>‹</span> 弱点
    </button>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="h-5 w-16 animate-pulse rounded bg-elevated" />
      <div className="h-6 w-48 animate-pulse rounded bg-elevated" />
      <div className="h-16 animate-pulse rounded-xl bg-elevated" />
      <div className="h-32 animate-pulse rounded-2xl bg-elevated" />
      <div className="h-32 animate-pulse rounded-2xl bg-elevated" />
    </div>
  );
}
