import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/common/Button';
import {
  acceptRequest,
  getProfile,
  listFriends,
  listRequests,
  listSuggestions,
  rejectRequest,
  removeFriend,
  searchUser,
  sendRequest,
  setShareProgress,
  type FriendItem,
  type FriendRequestItem,
  type SearchResult,
  type UserBrief,
} from '@/features/friends/api';

/**
 * 好友（方案 3.10）。
 *
 * 【这个界面最要紧的一件事：把「看不到」说清楚】
 *
 * 好友默认什么都看不到。对方开启分享后，也只能看到两项**计数**：
 * 连续天数、今天是否练过。看不到弱点、回环、撑住率、观察、事件卡。
 *
 * 界面上必须让这件事**看起来是设计，而不是坏了**：
 *   · 对方未开启分享时显示「对方未开启分享」，而不是显示 0 或空白
 *   · 页面顶部写清楚「好友看不到你的弱点」，否则用户会不敢加好友
 *
 * 这两条不是文案洁癖。一个默认私密的功能，如果界面让人觉得
 * 「数据会漏出去」，用户就不会用；反过来如果界面让人觉得
 * 「什么都共享」，用户会被吓到。方案 3.10 定的边界必须在 UI 上说得出。
 */
export function FriendsSection() {
  const [friends, setFriends] = useState<FriendItem[] | null>(null);
  const [incoming, setIncoming] = useState<FriendRequestItem[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequestItem[]>([]);
  /** 用我的邀请码注册、但还不是好友的人（方案 3.10 邀请关系） */
  const [suggestions, setSuggestions] = useState<UserBrief[]>([]);
  const [sharing, setSharing] = useState(false);

  const [keyword, setKeyword] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [f, r, s, p] = await Promise.all([
        listFriends(),
        listRequests(),
        listSuggestions(),
        getProfile(),
      ]);
      setFriends(f.friends);
      setIncoming(r.incoming);
      setOutgoing(r.outgoing);
      setSuggestions(s.suggestions);
      setSharing(p.profile.share_progress_with_friends);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '好友列表加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 把异步动作包一层：统一 busy 标记 + 统一错误兜底 + 做完重新拉取 */
  async function run(key: string, fn: () => Promise<void>, done?: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
      if (done) setNotice(done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
    } finally {
      setBusy(null);
    }
  }

  async function handleSearch() {
    const name = keyword.trim();
    if (!name) return;
    setSearching(true);
    setError(null);
    setNotice(null);
    try {
      setResult(await searchUser(name));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '查找失败');
    } finally {
      setSearching(false);
    }
  }

  async function handleToggleShare() {
    const next = !sharing;
    setBusy('share');
    setError(null);
    try {
      // 乐观更新：这个开关是本地偏好，失败会回滚并提示
      setSharing(next);
      await setShareProgress(next);
      setNotice(next ? '已开启。好友能看到你的连续天数和今天是否练过。' : '已关闭，好友立刻看不到。');
    } catch (cause) {
      setSharing(!next);
      setError(cause instanceof Error ? cause.message : '设置失败');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {/* 边界要先说清楚，否则用户不敢加人 */}
      <p className="mt-2 text-xs leading-relaxed text-tertiary">
        好友之间默认互不可见。
        <span className="text-secondary">
          你的弱点、回环、撑住率、AI 观察，好友都看不到。
        </span>
        加好友只为一件事：辩论房可以直接从好友里邀请。
      </p>

      {/* ── 待处理申请 ─────────────────────────────────── */}
      {incoming.length > 0 ? (
        <div className="mt-4 rounded-xl bg-elevated px-3 py-3">
          <p className="text-[13px] text-secondary">
            收到的申请（{incoming.length}）
          </p>
          <ul className="mt-2 space-y-2">
            {incoming.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] text-primary">{item.nickname}</span>
                <span className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    loading={busy === `acc-${item.id}`}
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`acc-${item.id}`, async () => {
                        await acceptRequest(item.id);
                      }, `已和 ${item.nickname} 成为好友`)
                    }
                  >
                    接受
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-tertiary"
                    loading={busy === `rej-${item.id}`}
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`rej-${item.id}`, async () => {
                        await rejectRequest(item.id);
                      }, '已拒绝。对方不能再向你申请')
                    }
                  >
                    拒绝
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── 用你的邀请码注册的人（方案 3.10 邀请关系）──────── */}
      {suggestions.length > 0 ? (
        <div className="mt-4 rounded-xl bg-elevated px-3 py-3">
          <p className="text-[13px] text-secondary">
            用你的邀请码注册的人（{suggestions.length}）
          </p>
          <p className="mt-1 text-xs leading-relaxed text-tertiary">
            他们已经是你的用户了，加好友后就能直接拉进辩论房。
          </p>
          <ul className="mt-2 space-y-2">
            {suggestions.map((item) => (
              <li key={item.user_id} className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] text-primary">{item.nickname}</span>
                <Button
                  variant="outline"
                  className="shrink-0"
                  loading={busy === `sug-${item.user_id}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`sug-${item.user_id}`, async () => {
                      await sendRequest(item.username);
                    }, `已向 ${item.nickname} 发出申请，等他接受`)
                  }
                >
                  加好友
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── 加好友 ─────────────────────────────────────── */}
      <div className="mt-4 border-t border-light pt-3">
        <p className="text-[13px] text-secondary">添加好友</p>
        <p className="mt-1 text-xs leading-relaxed text-tertiary">
          输入对方的用户名（不是昵称），需要完全一致。
        </p>
        <div className="mt-2 flex items-center gap-2">
          {/* 不用 Field：它的 label 是必填的，而这里是内联 输入框+按钮 的布局，
              传空 label 会渲染一个空的 <label>（无障碍上不干净）。 */}
          <input
            value={keyword}
            aria-label="对方的用户名"
            placeholder="对方的用户名"
            onChange={(event) => {
              setKeyword(event.target.value);
              setResult(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleSearch();
            }}
            className="h-11 min-w-0 flex-1 rounded-xl border border-light bg-surface px-3 text-[15px] text-primary placeholder:text-disabled focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <Button
            variant="outline"
            className="shrink-0"
            loading={searching}
            disabled={!keyword.trim() || searching}
            onClick={() => void handleSearch()}
          >
            查找
          </Button>
        </div>

        {result !== null ? (
          result.found && result.user ? (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-elevated px-3 py-2">
              <span className="truncate text-[13px] text-primary">
                {result.user.nickname}
                <span className="ml-1 text-xs text-tertiary">@{result.user.username}</span>
              </span>
              {result.already_friends ? (
                <span className="shrink-0 text-xs text-tertiary">已经是好友</span>
              ) : (
                <Button
                  variant="outline"
                  className="shrink-0"
                  loading={busy === 'send'}
                  disabled={busy !== null}
                  onClick={() =>
                    void run('send', async () => {
                      await sendRequest(result.user!.username);
                      setKeyword('');
                      setResult(null);
                    }, '申请已发出')
                  }
                >
                  加好友
                </Button>
              )}
            </div>
          ) : (
            <p className="mt-2 text-xs text-tertiary">找不到这个用户。</p>
          )
        ) : null}

        {outgoing.length > 0 ? (
          <p className="mt-2 text-xs text-tertiary">
            已发出、等待对方处理：{outgoing.map((o) => o.nickname).join('、')}
          </p>
        ) : null}
      </div>

      {/* ── 好友列表 ───────────────────────────────────── */}
      <div className="mt-4 border-t border-light pt-3">
        <p className="text-[13px] text-secondary">
          我的好友{friends ? `（${friends.length}）` : ''}
        </p>

        {friends === null ? (
          <p className="mt-2 text-xs text-tertiary">正在读取…</p>
        ) : friends.length === 0 ? (
          <p className="mt-2 text-xs leading-relaxed text-tertiary">
            还没有好友。上面输入用户名就能加。
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-light">
            {friends.map((friend) => (
              <li key={friend.user_id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-primary">{friend.nickname}</span>
                  <span className="block text-xs text-tertiary">
                    {friend.sharing
                      ? `连续 ${friend.streak_days} 天${
                          friend.practiced_today ? ' · 今天练过了' : ' · 今天还没练'
                        }`
                      : '对方未开启分享'}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  className="shrink-0 text-tertiary"
                  loading={busy === `del-${friend.user_id}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`del-${friend.user_id}`, async () => {
                      await removeFriend(friend.user_id);
                    }, `已删除 ${friend.nickname}`)
                  }
                >
                  删除
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── 分享开关 ───────────────────────────────────── */}
      <div className="mt-4 border-t border-light pt-3">
        <p className="text-[13px] text-secondary">向好友分享今日进度</p>
        <p className="mt-1 text-xs leading-relaxed text-tertiary">
          开启后好友能看到两项：<span className="text-secondary">连续天数</span>和
          <span className="text-secondary">今天是否练过</span>。
          看不到你练的是什么、弱点是什么。随时可以关，关掉立刻生效。
        </p>
        <div className="mt-2">
          {/* 刻意不做自绘的开关滑块：theme 的 backgroundColor 里没有品牌色
              （只有 base / surface / elevated / inset 与 sticky-* 系列），
              自绘会引到一个不存在的类名上。用已验证的 Button 变体表达开/关。

              ⚠️ 这条注释原本写的是 sticky-* 紧跟斜杠 rate-* —— 中间那个
              「星号+斜杠」把 JSX 注释提前闭合了，后面的中文变成 JSX 文本，
              tsc 报 Invalid character / Expression expected。
              在 JSX 注释里不能让星号紧跟着斜杠。 */}
          <Button
            variant={sharing ? 'outline' : 'ghost'}
            loading={busy === 'share'}
            disabled={busy !== null}
            onClick={() => void handleToggleShare()}
          >
            {sharing ? '已开启 · 点此关闭' : '已关闭 · 点此开启'}
          </Button>
        </div>
      </div>

      {error ? <p className="mt-3 text-xs leading-relaxed text-danger">{error}</p> : null}
      {notice ? <p className="mt-3 text-xs leading-relaxed text-secondary">{notice}</p> : null}
    </>
  );
}
