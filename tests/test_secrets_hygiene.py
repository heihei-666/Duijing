"""对镜 · 密钥卫生测试

这个文件存在的唯一目的：**防止密钥被提交进版本库**。

背景：项目部署时需要在 `.env` 里放 API Key，而仓库是公开的。
`.gitignore` 能挡住 `.env`，但它是「约定」不是「强制」——
`git add -f .env` 就能绕过，手工复制粘贴到别的文件里更是防不住。

所以在测试里加一道**可执行的**检查：只要有人在受版本控制的文件里留下
真实形态的密钥，或者不小心把 `.env` 提交了，测试立刻失败。

它同时是一份文档：告诉后来的人「这个项目的密钥规则是什么、为什么」。
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


def _git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        pytest.skip(f"不是 git 仓库或 git 不可用：{result.stderr.strip()[:80]}")
    return result.stdout


# 真实密钥的形态：sk- 后面跟一长串随机字符。
# 占位符（sk-xxx、sk-fake、sk-your-key）长度不够，不会命中。
SECRET_PATTERN = re.compile(r"sk-[A-Za-z0-9]{20,}")

# 允许出现「像密钥」字样的位置：都是明确的占位/测试用途，
# 加进来时必须写清理由，不能随手往里塞。
ALLOWED_FILES = {
    ".env.example",  # 模板，值为空
}


@pytest.fixture(scope="module")
def tracked_files() -> list[str]:
    return [line for line in _git("ls-files").splitlines() if line.strip()]


class TestSecretsNeverTracked:
    def test_env_is_gitignored(self):
        """`.env` 必须被忽略。

        注意 `.gitignore` 里的规则本身也是受版本控制的——
        它是「告诉 git 不要跟踪哪些文件」，而不是「上传之后再隐藏」。
        文件从未离开过本机。
        """
        ignore_content = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
        assert re.search(r"^\.env$", ignore_content, re.MULTILINE), (
            ".gitignore 里必须有一条独立的 `.env` 规则"
        )

        output = _git("check-ignore", "-v", ".env")
        assert ".env" in output, ".env 没有被 git 忽略"

    def test_env_is_not_tracked(self, tracked_files):
        """`.env` 绝不能出现在受版本控制的文件列表里。"""
        offenders = [f for f in tracked_files if f == ".env" or f.endswith("/.env")]
        assert not offenders, (
            f"这些 .env 文件被 git 跟踪了，密钥会随仓库公开：{offenders}\n"
            f"修复：git rm --cached {' '.join(offenders)}"
        )

    def test_no_secrets_in_tracked_files(self, tracked_files):
        """受版本控制的文件里不能出现真实形态的密钥。"""
        offenders: list[str] = []

        for relative in tracked_files:
            if relative in ALLOWED_FILES:
                continue
            path = REPO_ROOT / relative
            if not path.is_file():
                continue
            # 只扫文本文件，跳过图片等二进制
            try:
                content = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue

            for match in SECRET_PATTERN.finditer(content):
                line_no = content[: match.start()].count("\n") + 1
                offenders.append(f"{relative}:{line_no}  {match.group()[:16]}…")

        assert not offenders, (
            "受版本控制的文件里出现了疑似真实密钥：\n  "
            + "\n  ".join(offenders)
            + "\n\n修复：把密钥移到 .env（已忽略），文件里只留空值或占位符。\n"
            "如果这确实是占位符，把它加进本文件的 ALLOWED_FILES 并写明理由。"
        )

    def test_database_and_runtime_artifacts_not_tracked(self, tracked_files):
        """数据库、JWT 密钥文件、构建产物都不能入库。"""
        forbidden_suffixes = (".db", ".db-wal", ".db-shm", ".pyc")
        offenders = [
            f
            for f in tracked_files
            if f.endswith(forbidden_suffixes)
            or f.startswith("data/")
            or f.startswith("node_modules/")
            or f.startswith("web/dist/")
            or "__pycache__" in f
        ]
        assert not offenders, f"这些运行时产物不该入库：{offenders}"

    def test_env_example_has_empty_secret_values(self):
        """模板文件可以入库，但值必须是空的。

        这是公开仓库的通行做法：让人知道要配哪些变量，但不泄露任何真实值。
        """
        example = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")

        for var in ("JWT_SECRET", "DEEPSEEK_API_KEY", "MIMO_API_KEY", "BOOTSTRAP_INVITE_CODE"):
            match = re.search(rf"^{var}=(.*)$", example, re.MULTILINE)
            assert match is not None, f".env.example 里应当有 {var} 这一项"
            assert match.group(1).strip() == "", (
                f".env.example 的 {var} 必须是空值，当前是 {match.group(1)!r}"
            )


class TestGitHistoryClean:
    """历史里也不能有——即使现在删掉了，旧提交仍然可以被翻出来。"""

    def test_env_never_appeared_in_history(self):
        output = _git("log", "--all", "--full-history", "--oneline", "--", ".env")
        assert not output.strip(), f"历史中有提交涉及 .env：\n{output}"

    def test_no_env_blob_in_history(self):
        listing = _git("rev-list", "--all", "--objects")
        offenders = [
            line.split(" ", 1)[1]
            for line in listing.splitlines()
            if line.count(" ") == 1 and line.split(" ", 1)[1].endswith("/.env")
        ]
        assert not offenders, f"历史对象中存在 .env：{offenders}"
