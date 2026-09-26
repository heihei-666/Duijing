import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/date';
import { SourceDebateButton } from '@/features/debate/SourceDebateButton';
import { AiIcon } from '@/features/weakness/icons';
import { TextAreaField } from '@/features/weakness/TextAreaField';
import {
  analyzeEventCards,
  createEventCard,
  EVENT_RESULT_CLASS,
  EVENT_RESULT_LABELS,
  listEventCards,
  type EventCardData,
} from '@/features/assets/api';

const PAGE_SIZE = 50;

/**
 * 事件卡历史（方案 3.4）。
 * 顶部是「+ 记一笔」的极简模式：只写一句 → POST /api/event-cards。
 * 保存后不弹窗、不打断，只在原地留一句「AI 稍后会判断关联和结果」。
 */
export function EventCardHistory() {
  const navigate = useNavigate();

  const [cards, setCards] = useState<EventCardData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 事件卡是永久保留的，久了会很长。分页加载而不是一次拉完——
  // 这个列表没有搜索，用户大多只看最近几条。
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [candidateCount, setCandidateCount] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await listEventCards({ limit: PAGE_SIZE });
      setCards(data.cards);
      setTotal(data.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '事件卡加载失败');
      setCards([]);
      setTotal(0);
    }
  }, []);

  /** 追加下一页。失败时保留已加载的内容，只提示这一次没成功。 */
  const loadMore = useCallback(async () => {
    if (loadingMore || !cards) return;
    setLoadingMore(true);
    try {
      const data = await listEventCards({ limit: PAGE_SIZE, offset: cards.length });
      // 按 id 去重：翻页期间若新增了事件卡，offset 会错位导致重复
      setCards((prev) => {
        const seen = new Set((prev ?? []).map((item) => item.id));
        return [...(prev ?? []), ...data.cards.filter((item) => !seen.has(item.id))];
      });
      setTotal(data.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载更多失败');
    } finally {
      setLoadingMore(false);
    }
  }, [cards, loadingMore]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave() {
    const trimmed = content.trim();
    if (!trimmed) return;

    setSaving(true);
    setError(null);
    setHint(null);
    try {
      const result = await createEventCard({ content: trimmed });
      setContent('');
      setHint(
        result.pending_confirm
          ? '记下了。AI 稍后会判断关联和结果，不确定的会标成待确认。'
          : result.auto_linked
            ? '记下了，已经关联到回环。'
            : '记下了。',
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后再试');
    } finally {
      setSaving(false);
    }
  }

  async function handleAnalyze() {
    setAnalyzing(true);
    setError(null);
    setAnalysis(null);
    try {
      const result = await analyzeEventCards();
      setCandidateCount(result.candidates.length);
      setAnalysis(
        `扫描了 ${result.scanned} 张，更新 ${result.cards_analyzed} 张，新增候选 ${result.candidates.length} 条。`,
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '分析失败，请稍后再试');
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-light bg-surface px-4 py-4 shadow-card">
        <p className="text-[13px] text-secondary">记一笔</p>
        <div className="mt-2">
          <TextAreaField
            aria-label="刚才发生了什么"
            placeholder="刚才发生了什么？一句话就够。"
            rows={2}
            maxLength={1000}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </div>
        <Button
          fullWidth
          className="mt-2"
          loading={saving}
          disabled={saving || content.trim() === ''}
          onClick={() => void handleSave()}
        >
          保存
        </Button>
        {hint ? <p className="mt-2 text-xs text-tertiary">{hint}</p> : null}
      </div>

      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[13px] text-secondary">
          事件卡历史
          <span className="ml-2 text-tertiary">{cards?.length ?? 0}</span>
        </p>
        <Button
          variant="outline"
          loading={analyzing}
          disabled={analyzing}
          onClick={() => void handleAnalyze()}
        >
          <AiIcon width={16} height={16} className="text-info" />
          分析最近事件卡
        </Button>
      </div>

      {analyzing ? (
        <p className="text-xs text-tertiary">正在让 AI 过一遍最近的事件卡，可能要十几秒。</p>
      ) : null}

      {analysis ? (
        <div className="rounded-xl bg-info-light px-4 py-3">
          <p className="text-[13px] leading-relaxed text-primary">{analysis}</p>
          {candidateCount > 0 ? (
            <button
              type="button"
              onClick={() => navigate('/weaknesses')}
              className="mt-1.5 text-[13px] text-info underline-offset-2 hover:underline"
            >
              去弱点墙看这 {candidateCount} 条候选
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-xs text-danger">{error}</p> : null}

      {cards === null ? (
        <p className="py-4 text-center text-[13px] text-tertiary">正在读取…</p>
      ) : cards.length === 0 ? (
        <EmptyState title="还没有事件卡" hint="日常里随手记一笔，攒起来才有得看。" />
      ) : (
        <ul className="space-y-4 border-l border-light pl-4">
          {cards.map((card) => (
            <li key={card.id} className="relative">
              <span
                aria-hidden
                className="absolute -left-[21px] top-1.5 h-1.5 w-1.5 rounded-full bg-strong"
              />
              <p className="text-[14px] leading-relaxed text-primary">{card.content}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="text-tertiary">{formatTimestamp(card.created_at)}</span>
                {card.result ? (
                  <span className={cn(EVENT_RESULT_CLASS[card.result])}>
                    {EVENT_RESULT_LABELS[card.result]}
                  </span>
                ) : null}
                {card.pending_confirm ? (
                  <span className="rounded-md bg-warning-light px-1.5 py-0.5 leading-4 text-warning">
                    待确认
                  </span>
                ) : null}
              </div>
              {card.linked_loops.length > 0 ? (
                <p className="mt-1 text-[11px] leading-5 text-tertiary">
                  关联回环：{card.linked_loops.map((loop) => loop.trigger_scene).join('、')}
                </p>
              ) : null}
              {/* 闭环入口：把这张卡直接变成一场辩论（辩题来源 P2）。
                  一键发起、不需要输入，成功后就跳进辩论房。 */}
              <SourceDebateButton
                source={{ kind: 'event_card', cardId: card.id }}
                variant="outline"
                className="mt-2"
              />
            </li>
          ))}
        </ul>
      )}

        {/* 还有更多时才显示。用 ghost 而不是主色——它是次要动作，
            不该和「记一笔」抢注意力。 */}
        {cards && cards.length > 0 && cards.length < total ? (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="mt-4 h-11 w-full rounded-xl text-[13px] text-brand transition-colors hover:bg-elevated disabled:opacity-50"
          >
            {loadingMore ? '加载中…' : `加载更早的（还有 ${total - cards.length} 条）`}
          </button>
        ) : null}
    </div>
  );
}
