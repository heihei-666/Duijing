import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { ApiError } from '@/api/client';
import type { DebateRoom } from '@/api/types';
import { Button } from '@/components/common/Button';
import { createDebateFromSource, listDebates } from '@/features/debate/api';
import { ClaimSheet } from '@/features/guest/ClaimSheet';
import { GUEST_COPY } from '@/features/guest/copy';
import { QUICK_TOPICS } from '@/features/status-bar/quickTopics';
import { cn } from '@/lib/cn';
import { isGuest } from '@/lib/roles';
import { useAuthStore } from '@/store/auth';

/** 场景描述上限，与后端 `CreateDebatePayload.scene` 的 max_length=500 对齐 */
const SCENE_MAX_CHARS = 500;

/** 预设题给几道：三屏内选完，不滚。多了选择成本反而上升。 */
const PRESET_COUNT = 3;

/**
 * 随机抓几道预设题。
 *
 * 为什么随机而不是固定前三道：访客很可能体验两次（每人每天 2 次），
 * 固定的话第二次看到的是同一批题，会显得这个产品只有三道题。
 * 洗牌后取前 N 道，第二次大概率不同，代码也只有几行。
 */
function pickPresets(count: number) {
  const pool = QUICK_TOPICS.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/**
 * 访客开辩页（`/start`）—— 「免费试用 3 分钟微辩论」点下去之后落的地方。
 *
 * 【为什么不是一个「注册表单前置」】
 *
 * 落地页承诺的是「不需要先注册」。所以这一页**不能有任何表单必填**：
 * 预设题点一下就开局（零输入），想说自己那件事的人再往下滚去写。
 * 两种人都在三秒内进到辩论房里。
 *
 * 【两块内容的顺序由入口决定】
 *
 * 从「记下一件让你不爽的事」进来的人，先看到描述框；从「免费试用」进来的，
 * 先看到预设题。同一个页面、两种排法，意图存在 auth store 的 `guestEntry`
 * 里（见 `store/auth.ts` 的说明：URL 参数会被 RootLayout 的重定向覆盖）。
 *
 * 【为什么预设题直接发 topic + stance，而不是 scene】
 *
 * 发 `{ topic, stance }` 时后端不会再调 AI 生成辩题（`create_debate` 里
 * `if not topic:` 整段跳过），只生成开场白 —— **省一次 AI 调用，而且快**。
 * 一道已经写好的题还要 AI 再「理解」一遍，纯属浪费。
 *
 * 【回合数正好是 4 轮】
 *
 * `decide_max_rounds` 对新手（访客的 profile 就是 novice）+ 短辩题 + 无回环
 * 算出 4 轮 —— 这就是「3 分钟微辩论」里那个 3 分钟的由来，不是随便写的数字。
 *
 * 【访客走了还能回来】
 *
 * 页面挂载时查一次进行中的辩论。访客关掉页面第二天再打开，
 * 上次没辩完的那场还在，直接「继续」—— 不然他会以为数据丢了，
 * 而那正好是他要注册时最需要相信的事。
 */
export default function StartDebatePage() {
  const navigate = useNavigate();
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const guestEntry = useAuthStore((state) => state.guestEntry);
  const guest = isGuest(user);
  /** 从「记下一件让你不爽的事」进来的：描述框摆最上面，并自动聚焦 */
  const sceneFirst = guestEntry === 'scene';

  const [presets] = useState(() => pickPresets(PRESET_COUNT));
  const [scene, setScene] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 撞到访客限额时为 true —— 三种限额（本人 / 本 IP / 全站）的文案
   * 结尾都是「注册后继续」，所以三种都指向同一个动作：认领账号。
   */
  const [quotaHit, setQuotaHit] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [resumable, setResumable] = useState<DebateRoom | null>(null);
  /** 已辩完、但观察还没保存的那一场（通常是当时没邀请码） */
  const [unsaved, setUnsaved] = useState<DebateRoom | null>(null);

  const sceneRef = useRef<HTMLTextAreaElement | null>(null);

  const busy = busyKey !== null;

  // 从「记下一件让你不爽的事」进来时直接聚焦，少一次点击
  useEffect(() => {
    if (!sceneFirst) return;
    const timer = window.setTimeout(() => sceneRef.current?.focus(), 120);
    return () => window.clearTimeout(timer);
  }, [sceneFirst]);

  /**
   * 上次留下的辩论摆出来。两个用途：
   *
   *   ① 没辩完的 —— 点「继续」，不然他会以为数据丢了
   *   ② 辩完但没保存的 —— 点「回看并保存」，回到那个房间就能补上邀请码
   *
   * ② 是认领需要邀请码之后新增的：当时没码的人关掉页面，第二天再来，
   * 如果这里什么都不显示，他就再也找不到那场辩论了 —— 而那正好是
   * 我们让他相信「数据还在、拿到码回来就行」的时刻，找不到就等于失信。
   *
   * 两个请求都用 allSettled：一个挂了不影响另一个，也不该阻塞新开一场。
   */
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([listDebates('active,paused'), listDebates('finished')]).then(
      ([active, finished]) => {
        if (cancelled) return;
        if (active.status === 'fulfilled') setResumable((active.value.rooms ?? [])[0] ?? null);
        if (finished.status === 'fulfilled') setUnsaved((finished.value.rooms ?? [])[0] ?? null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** 统一处理开局失败的三种情况：限额 → 引导认领；其余 → 原样显示文案 */
  const handleFailure = useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : '没能开起来，请稍后再试';
    setError(message);
    if (cause instanceof ApiError && (cause.status === 403 || cause.status === 429)) {
      setQuotaHit(true);
    }
  }, []);

  const startFromPreset = useCallback(
    async (topic: string, stance: string, key: string) => {
      if (busy) return;
      setBusyKey(key);
      setError(null);
      setQuotaHit(false);
      try {
        const { room } = await createDebateFromSource({
          topic,
          stance,
          source_type: 'manual',
        });
        navigate(`/debates/${room.id}`);
      } catch (cause) {
        handleFailure(cause);
        setBusyKey(null);
      }
    },
    [busy, handleFailure, navigate],
  );

  const startFromScene = useCallback(async () => {
    const text = scene.trim();
    if (text === '' || busy) return;
    setBusyKey('scene');
    setError(null);
    setQuotaHit(false);
    try {
      // 只发 scene：辩题交给 AI 从这件事里提炼，用户说不出「辩题」很正常
      const { room } = await createDebateFromSource({ scene: text, source_type: 'manual' });
      navigate(`/debates/${room.id}`);
    } catch (cause) {
      handleFailure(cause);
      setBusyKey(null);
    }
  }, [busy, handleFailure, navigate, scene]);

  const handleSceneSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void startFromScene();
  };

  // 未登录：这里不该出现（入口只在落地页按钮后面），回到落地页
  if (status !== 'authenticated' || !user) return <Navigate to="/" replace />;
  // 正式账号走正常辩论入口，这一页只服务访客。
  // `claimOpen` 例外：认领成功的那一刻 guest 就变 false 了，
  // 直接重定向会把「已经保存好了」那一屏吞掉，用户不知道刚才发生了什么。
  if (!guest && !claimOpen) return <Navigate to="/debates" replace />;

  /* ── 两块内容：顺序由入口决定，内容只有一份 ────────────────── */

  const presetSection = (
    <section className="mt-8 space-y-2.5">
      <h2 className="text-xs text-tertiary">{GUEST_COPY.startPresetLabel}</h2>
      {presets.map((preset, index) => (
        <div
          key={preset.topic}
          className="rounded-xl border border-light bg-surface px-4 py-3.5 shadow-card"
        >
          <p className="text-[15px] leading-relaxed text-primary">{preset.topic}</p>
          <div className="mt-3 flex gap-2">
            {preset.stances.map((stance) => {
              const key = `preset-${index}-${stance}`;
              return (
                <Button
                  key={stance}
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  loading={busyKey === key}
                  disabled={busy}
                  onClick={() => void startFromPreset(preset.topic, stance, key)}
                >
                  {stance}
                </Button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );

  const sceneSection = (
    <form onSubmit={handleSceneSubmit} className="mt-8 space-y-2.5" noValidate>
      <h2 className="text-xs text-tertiary">{GUEST_COPY.startSceneLabel}</h2>
      <textarea
        ref={sceneRef}
        value={scene}
        maxLength={SCENE_MAX_CHARS}
        rows={3}
        placeholder={GUEST_COPY.startScenePlaceholder}
        onChange={(event) => setScene(event.target.value)}
        className={cn(
          'min-h-[96px] w-full resize-none rounded-xl border border-light bg-surface',
          'px-3 py-2.5 text-[15px] leading-relaxed text-primary',
          'placeholder:text-disabled',
          'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary',
        )}
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] tabular-nums text-tertiary">
          {Array.from(scene).length} / {SCENE_MAX_CHARS}
        </p>
        <Button type="submit" loading={busyKey === 'scene'} disabled={busy || scene.trim() === ''}>
          {GUEST_COPY.startSceneCta}
        </Button>
      </div>
    </form>
  );

  /** 上次留下的那场：没辩完的优先（那件事还没做完），否则是辩完没保存的 */
  const leftover = resumable ?? unsaved;

  return (
    <div className="min-h-screen bg-base">
      <div className="mx-auto w-full max-w-2xl px-4 pb-10 pt-8 lg:max-w-3xl lg:px-6">
        <header>
          <p className="text-xs tracking-[0.2em] text-tertiary">对 镜</p>
          <h1 className="mt-4 text-[24px] font-medium leading-snug text-primary lg:text-[28px]">
            {GUEST_COPY.startTitle}
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-secondary">{GUEST_COPY.startLead}</p>
        </header>

        {/*
          ── 上次留下的那场 ─────────────────────────────────
          优先显示「没辩完的」——那件事还没做完；
          没有的话再显示「辩完但没保存的」，让他回去补邀请码。
          两张卡长得一样，只有文案和右侧动作不同。
        */}
        {leftover ? (
          <button
            type="button"
            onClick={() => navigate(`/debates/${leftover.id}`)}
            className="mt-6 flex min-h-[56px] w-full items-center justify-between gap-3 rounded-xl border border-light bg-surface px-4 py-3 text-left shadow-card transition-colors hover:bg-elevated"
          >
            <span className="min-w-0">
              <span className="block text-[11px] text-tertiary">
                {resumable ? GUEST_COPY.startResumeLabel : GUEST_COPY.startReviewLabel}
              </span>
              <span className="mt-0.5 line-clamp-2 block text-[14px] leading-snug text-primary">
                {leftover.topic}
              </span>
            </span>
            <span className="shrink-0 text-[13px] text-brand">
              {resumable ? '继续' : GUEST_COPY.startReviewCta}
            </span>
          </button>
        ) : null}

        {/*
          两块内容只写一份，顺序由入口决定。
          这里刻意用三元 + Fragment 而不是数组：数组会让 React 要求每个
          元素有 key，而这两块**不是列表**，是「谁先谁后」的两种排版。
        */}
        {sceneFirst ? (
          <>
            {sceneSection}
            {presetSection}
          </>
        ) : (
          <>
            {presetSection}
            {sceneSection}
          </>
        )}

        {/* ── 错误 / 限额 ─────────────────────────────────── */}
        {error ? (
          <div className="mt-5 rounded-xl border border-danger-light bg-danger-light px-4 py-3">
            <p className="text-[13px] leading-relaxed text-primary">{error}</p>
            {quotaHit ? (
              <Button size="sm" className="mt-2.5" onClick={() => setClaimOpen(true)}>
                {GUEST_COPY.quotaCta}
              </Button>
            ) : null}
          </div>
        ) : null}

        <p className="mt-8 text-center text-[11px] leading-relaxed text-tertiary">
          {GUEST_COPY.ctaHint}
        </p>
      </div>

      <ClaimSheet
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        // 撞到限额才走到这里的人还没辩成一场，没有任何观察可「保存」
        successBody={GUEST_COPY.claimSuccessBodyEmpty}
      />
    </div>
  );
}
