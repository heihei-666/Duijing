import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError } from '@/api/client';
import { Button } from '@/components/common/Button';
import { Field } from '@/components/common/Field';
import { Sheet } from '@/components/common/Sheet';
import { useAuthStore } from '@/store/auth';

import { GUEST_COPY } from './copy';

/* ------------------------------------------------------------ 本地校验 */

/**
 * 前端先挡一遍，规则与后端 `app/safety` 里的两个校验函数**逐条对齐**：
 *   `app/security.py::validate_username`          3–32 位，字母 / 数字 / `_` / `-`
 *   `app/security.py::validate_password_strength` ≥ 8 位，不能是纯数字
 *
 * 【为什么明知道后端会校验，前端还要再写一遍】
 *
 * 不是为了「安全」（前端校验永远不可信），是为了**不让用户白跑一趟**：
 * 填完整个表单点提交、等一个网络往返、才被告知「用户名只能包含字母数字」，
 * 这是最容易被放弃的一步 —— 而这一步正好是整条转化链路的最后一步。
 *
 * 两边规则不一致的风险是**误拦**（前端说不行、后端其实行）。
 * 所以这里刻意写得比后端**宽**：宁可放过去让后端判，也不要自己拦错。
 */
const USERNAME_MIN = 3;
const USERNAME_MAX = 32;
const PASSWORD_MIN = 8;

/** 允许：Unicode 字母（含中文）、数字、下划线、短横线 —— 与 Python `str.isalnum()` 对齐 */
const USERNAME_CHAR = /^[\p{L}\p{N}_-]$/u;

function usernameIssue(value: string): string | null {
  if (value.length < USERNAME_MIN || value.length > USERNAME_MAX) {
    return `用户名长度需在 ${USERNAME_MIN}–${USERNAME_MAX} 位之间`;
  }
  for (const char of value) {
    if (!USERNAME_CHAR.test(char)) return '用户名只能包含字母、数字、下划线和短横线';
  }
  return null;
}

function passwordIssue(value: string): string | null {
  if (value.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (value.length > 128) return '密码过长';
  if (/^\p{N}+$/u.test(value)) return '密码不能是纯数字';
  return null;
}

/* ---------------------------------------------------------------- 组件 */

interface ClaimSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * 认领成功后那句说明，默认是「这条观察留在你名下了」。
   *
   * 从「撞到限额」路径进来的人其实还没有任何观察，那时候必须换一句
   * 朴素的话 —— 在成功页上编造一个不存在的成果，是这条链路里最容易
   * 让人失去信任的一处。
   */
  successBody?: string;
}

/**
 * 认领访客账号（「保存这条观察」）。
 *
 * 背后是 `POST /api/auth/claim`：**原地**把当前访客账号补齐用户名 / 密码 / 昵称，
 * `is_guest` 置 false，并重签令牌。所以：
 *
 *   · 数据不搬家 —— 刚才那场辩论、AI 的观察、复盘，全都还挂在同一个 id 上，
 *     用户不会看到「刚才辩的东西没了」。这是「访客 = 临时用户」这个设计
 *     最大的好处：转化路径上没有数据搬迁，也就没有搬迁失败的可能。
 *   · 不新建账号 —— 所以也不需要邀请码。访客是从落地页进来的，
 *     手上不可能有邀请码，这时候要他填码等于把门关上。
 *
 * 【为什么成功后不自动跳走】
 *
 * 自动跳页会让人不知道自己刚才做了什么。这里停在原地、明确显示
 * 「已经保存好了」，再由他自己点「进入对镜」—— 一个动作对应一个确认。
 */
export function ClaimSheet({ open, onClose, successBody }: ClaimSheetProps) {
  const navigate = useNavigate();
  const claimAccount = useAuthStore((state) => state.claimAccount);

  const [username, setUsername] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [claimed, setClaimed] = useState(false);
  /** 整表错误（接口返回的、或与某个字段无关的） */
  const [error, setError] = useState<string | null>(null);
  /** 用户名单独的错误 —— 409 要显示在用户名下面，而不是表单底部 */
  const [usernameError, setUsernameError] = useState<string | null>(null);

  // 每次打开都从干净状态开始：上一次成功过之后再打开，不能还显示「已保存」
  useEffect(() => {
    if (!open) return;
    setUsername('');
    setNickname('');
    setPassword('');
    setSubmitting(false);
    setClaimed(false);
    setError(null);
    setUsernameError(null);
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedUsername = username.trim();
    const trimmedNickname = nickname.trim();

    const nameIssue = usernameIssue(trimmedUsername);
    if (nameIssue) {
      setUsernameError(nameIssue);
      return;
    }
    const passwordProblem = passwordIssue(password);
    if (passwordProblem) {
      setError(passwordProblem);
      return;
    }

    setSubmitting(true);
    setError(null);
    setUsernameError(null);
    try {
      await claimAccount({
        username: trimmedUsername,
        password,
        // 昵称选填：留空时后端用用户名兜底，所以这里显式发空串而不是省略字段
        nickname: trimmedNickname,
      });
      setClaimed(true);
    } catch (cause) {
      // 409 = 用户名被占用。这是唯一一个「换个名字就能过」的错误，
      // 必须落在用户名输入框下面，否则用户不知道要改哪里。
      if (cause instanceof ApiError && cause.status === 409) {
        setUsernameError(cause.message);
      } else {
        setError(cause instanceof Error ? cause.message : '保存失败，请稍后再试');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const close = () => {
    if (submitting) return;
    onClose();
  };

  return (
    <Sheet
      open={open}
      title={claimed ? GUEST_COPY.claimSuccessTitle : GUEST_COPY.claimTitle}
      onClose={close}
      footer={
        claimed ? (
          <Button
            size="lg"
            fullWidth
            onClick={() => {
              onClose();
              navigate('/');
            }}
          >
            {GUEST_COPY.claimSuccessCta}
          </Button>
        ) : (
          <div className="flex gap-3">
            <Button variant="outline" fullWidth disabled={submitting} onClick={close}>
              {GUEST_COPY.claimClose}
            </Button>
            {/*
              提交按钮放在 footer 里、用 form="guest-claim-form" 关联到下面的表单：
              Sheet 的 footer 在 <form> 之外，不用 form 属性点它不会提交。
            */}
            <Button
              type="submit"
              form="guest-claim-form"
              fullWidth
              loading={submitting}
            >
              {GUEST_COPY.claimSubmit}
            </Button>
          </div>
        )
      }
    >
      {claimed ? (
        <div className="space-y-3">
          <p className="text-[15px] leading-relaxed text-primary">
            {successBody ?? GUEST_COPY.claimSuccessBody}
          </p>
          <p className="text-xs leading-relaxed text-tertiary">
            用户名是你下次登录用的名字，密码只有你自己知道。
          </p>
        </div>
      ) : (
        <form id="guest-claim-form" onSubmit={handleSubmit} className="space-y-4" noValidate>
          <p className="text-[13px] leading-relaxed text-secondary">{GUEST_COPY.claimLead}</p>

          <Field
            label={GUEST_COPY.claimUsername}
            name="username"
            autoComplete="username"
            placeholder="例如 lin1990"
            hint={GUEST_COPY.claimUsernameHint}
            error={usernameError}
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              // 用户一动手就把 409 的错误清掉：错误是对「上一个值」的判决，
              // 留着它会让用户以为改名后还是不行
              if (usernameError) setUsernameError(null);
            }}
          />

          <Field
            label={GUEST_COPY.claimNickname}
            name="nickname"
            autoComplete="nickname"
            placeholder="选填"
            hint={GUEST_COPY.claimNicknameHint}
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
          />

          <Field
            label={GUEST_COPY.claimPassword}
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder={GUEST_COPY.claimPasswordHint}
            hint={GUEST_COPY.claimPasswordHint}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          {error ? <p className="text-xs leading-relaxed text-danger">{error}</p> : null}

          <p className="text-[11px] leading-relaxed text-tertiary">{GUEST_COPY.saveRetention}</p>
        </form>
      )}
    </Sheet>
  );
}
