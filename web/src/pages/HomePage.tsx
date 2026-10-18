import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { observationApi, statusApi } from '@/api/client';
import type { StatusBar, TodayLoop } from '@/api/types';
import { Button } from '@/components/common/Button';
import { EnergySheet } from '@/features/status-bar/EnergySheet';
import { EventCardHero } from '@/features/status-bar/EventCardHero';
import { GreetingLine } from '@/features/status-bar/GreetingLine';
import { ObservationSection } from '@/features/status-bar/ObservationSection';
import { PastYouSection } from '@/features/status-bar/PastYouSection';
import { QuickDebateSheet } from '@/features/status-bar/QuickDebateSheet';
import { QuickEventCardSheet } from '@/features/status-bar/QuickEventCardSheet';
import { StatusHeader } from '@/features/status-bar/StatusHeader';
import { TodayLoopsSection } from '@/features/status-bar/TodayLoopsSection';
import { useOnboardingStore } from '@/store/onboarding';

/**
 * 首页。
 *
 * 【首屏只有两个核心动作】
 *
 * 用户的原话是「布局出现了严重的功能重叠和视觉打架」。上一版首屏有：
 * 事件卡（记一笔）、即兴辩论（开始）、AI 观察空态（**又一个记一笔**）、
 * 底部全宽「和 AI 辩一轮」—— **四个入口，其中两对是重复的**。
 *
 * 现在收成两个：
 *   ① 记一笔     —— 最低门槛，了解盲区
 *   ② 3 分钟辩论 —— 选立场开辩，实战照镜子
 * 其余一律「有真实数据才出现」：
 *   · 过去的你  —— 有跨时间的撑住率对比才有意义
 *   · AI 观察   —— 有真实观察才出现（空态不再占位，它以前和①逐字重复）
 *   · 今天练什么 —— 有回环才出现（新用户看到的是②那张即兴辩论卡）
 *
 * 分工（每块各自收形，空状态不喧哗）：
 *   记一笔   → QuickEventCardSheet（一句话，不跳页）
 *   3 分钟辩论 → QuickDebateSheet（随机辩题 + 两个立场 → 直接进辩论房）
 *   AI 观察  → 直接在这块里「加入 / 忽略」
 */
export default function HomePage() {
  const navigate = useNavigate();

  const [data, setData] = useState<StatusBar | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [energyOpen, setEnergyOpen] = useState(false);
  const [savingEnergy, setSavingEnergy] = useState(false);
  const [energyError, setEnergyError] = useState<string | null>(null);

  const [pendingObservationId, setPendingObservationId] = useState<number | null>(null);
  const [observationError, setObservationError] = useState<string | null>(null);

  /** 即兴辩论 / 极简事件卡：两个核心动作各唤起一个 Sheet，都不跳页 */
  const [quickDebateOpen, setQuickDebateOpen] = useState(false);
  const [quickRecordOpen, setQuickRecordOpen] = useState(false);

  /** 把「是不是全新用户」同步给全局：导航栏要给弱点/资产挂锁，需要这个值 */
  const setFresh = useOnboardingStore((s) => s.setFresh);

  /** silent = 后台刷新，不切成骨架屏（处理 AI 观察后用） */
  const load = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const next = await statusApi.getStatusBar();
        setData(next);
        // 侧边栏靠这个值决定要不要给「弱点 / 资产」挂锁
        setFresh(next.is_fresh_start === true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '状态栏加载失败');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [setFresh],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const handleSaveEnergy = useCallback(async (energy: number) => {
    setSavingEnergy(true);
    setEnergyError(null);
    try {
      const saved = await statusApi.saveDailyState({ energy });
      // 用服务端返回值回填，避免前后端对「今天」的判定不一致
      setData((previous) => (previous ? { ...previous, energy: saved.energy } : previous));
      setEnergyOpen(false);
    } catch (cause) {
      setEnergyError(cause instanceof Error ? cause.message : '保存失败，请稍后再试');
    } finally {
      setSavingEnergy(false);
    }
  }, []);

  const handleObservation = useCallback(
    async (id: number, action: 'accept' | 'ignore') => {
      setPendingObservationId(id);
      setObservationError(null);
      try {
        if (action === 'accept') {
          await observationApi.accept(id);
        } else {
          await observationApi.ignore(id);
        }
        // 契约要求：处理完刷新状态栏（AI 观察块可能直接空了）；静默刷新，不闪骨架屏
        await load(true);
      } catch (cause) {
        setObservationError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
      } finally {
        setPendingObservationId(null);
      }
    },
    [load],
  );

  const handleSelectLoop = useCallback(
    (loop: TodayLoop) => {
      // TODO(弱点详情)：弱点详情页由同事实现；届时用 ?loop=<loop_id> 直接定位到该回环
      navigate(`/weaknesses/${loop.weakness_id}?loop=${loop.loop_id}`);
    },
    [navigate],
  );

  if (loading) return <HomeSkeleton />;

  if (error || !data) {
    return (
      <div className="rounded-2xl border border-light bg-surface p-6 text-center shadow-card">
        <p className="text-[13px] text-secondary">{error ?? '状态栏加载失败'}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
          重试
        </Button>
      </div>
    );
  }

  /**
   * 全新用户：从未留下任何痕迹（由服务端判定）。
   * 只影响两件事：AI 观察卡是否有内容、以及导航栏要不要给弱点/资产挂锁。
   */
  const isFreshStart = data.is_fresh_start === true;

  /**
   * 「3 分钟辩论」这张卡：**总是在第 2 位**。
   *
   * 上一版它只在新用户时以「想不想来一次即兴辩论」的形式出现，
   * 老用户看到的是回环列表，而「和 AI 辩一轮」被放在页面最底部当第三个入口 ——
   * 用户的原话是「功能重叠和视觉打架」。
   * 现在辩论入口固定在第 2 张卡里：有回环就列回环，没回环就推即兴辩论，
   * 两者都在卡内提供「选立场开辩」。
   */
  const hasLoops = data.today_loops.length > 0;

  return (
    <div className="space-y-4">
      <StatusHeader
        date={data.date}
        weekday={data.weekday}
        energy={data.energy}
        streakDays={data.streak_days}
        onEditEnergy={() => {
          setEnergyError(null);
          setEnergyOpen(true);
        }}
      />

      {/* 先说话，再给数据 —— 首页不该像一个业绩看板 */}
      <GreetingLine text={data.greeting} />

      {/*
        ── 核心动作 ①：记一笔 ──────────────────────────────
        门槛最低，永远排第一。文案由 EventCardHero 自己持有。
      */}
      <EventCardHero onRecord={() => setQuickRecordOpen(true)} />

      {/*
        ── 核心动作 ②：3 分钟辩论 ──────────────────────────
        有回环列回环（那是用户自己攒下的东西，比随机辩题更值得看），
        没有就给即兴辩论入口。两种情况都提供「选立场开辩」。
      */}
      <TodayLoopsSection
        loops={data.today_loops}
        onSelect={handleSelectLoop}
        onQuickDebate={() => setQuickDebateOpen(true)}
        spacious={isFreshStart}
      />

      {/*
        ── 过去的你：有跨时间对比才有意义 ──────────────────
        服务端算不出（历史不足两侧各 2 次触发）就给 null，整块不渲染。
      */}
      {data.past_you ? <PastYouSection data={data.past_you} /> : null}

      {/*
        ── AI 观察：**有真实观察才出现** ────────────────────
        它的空状态以前和「记一笔」那张卡逐字重复（两段「记录一个你不爽的瞬间，
        AI 帮你看看盲区」），这就是用户说的「功能完全重复」。
        现在空的时候整块消失，首页只剩两个动作；有观察才长出来。
      */}
      {data.observations.length > 0 ? (
        <ObservationSection
          observations={data.observations}
          pendingId={pendingObservationId}
          error={observationError}
          onAccept={(id) => void handleObservation(id, 'accept')}
          onIgnore={(id) => void handleObservation(id, 'ignore')}
        />
      ) : null}

      {/* 全新用户的收尾：不再放任何按钮，只留一句「你来了」 */}
      {isFreshStart && !hasLoops ? (
        <p className="pt-1 text-center text-[11px] text-disabled">这是你的第一站</p>
      ) : null}

      <QuickDebateSheet open={quickDebateOpen} onClose={() => setQuickDebateOpen(false)} />

      <QuickEventCardSheet
        open={quickRecordOpen}
        onClose={() => setQuickRecordOpen(false)}
        // 记完静默刷新：可能已经自动关联回环、写了日志，AI 观察块也可能变了
        onSaved={() => void load(true)}
      />

      <EnergySheet
        open={energyOpen}
        value={data.energy}
        saving={savingEnergy}
        error={energyError}
        onClose={() => setEnergyOpen(false)}
        onSubmit={(energy) => void handleSaveEnergy(energy)}
      />
    </div>
  );
}

/** 首页骨架屏：只用中性底色，不闪烁彩色 */
function HomeSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="h-5 w-40 animate-pulse rounded bg-elevated" />
      <div className="h-28 animate-pulse rounded-2xl bg-elevated" />
      <div className="h-24 animate-pulse rounded-2xl bg-elevated" />
      <div className="h-24 animate-pulse rounded-2xl bg-elevated" />
    </div>
  );
}

