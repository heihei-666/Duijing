"""对镜 · 可移植性回归测试

锁的是**同一类** bug：代码/配置默认了 UTF-8 环境，却没有把它固定下来。

2026-10-03 的外部审查在中文 Windows（cp936）上实测复现了两个实例：

  1. `pip install -r requirements.txt` 直接 UnicodeDecodeError
     —— 文件是合法 UTF-8，但无 BOM、无 PEP 263 cookie，而 pip < 25
     不先试 UTF-8，直接落到 locale 编码。中文注释里的「。」就打挂了。
  2. `tests/test_secrets_hygiene.py::test_no_env_blob_in_history` 失败
     —— `subprocess.run(..., text=True)` 没传 encoding，git 输出的 UTF-8
     在 cp936 解不开，`stdout` 变 None → AttributeError。

两个在 Ubuntu 上都不会出现，所以「没有 CI + 只在 Linux 上跑」时它们永远不会暴露。
这个文件就是那道缺掉的防线。
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

# PEP 263：编码声明必须出现在前两行
_CODING_COOKIE = ("coding:", "coding=")


class TestRequirementsFilesAreEncodingSafe:
    """pip 读 requirements 走的是 locale 编码，所以这两个文件必须自带编码声明。"""

    @pytest.mark.parametrize("name", ["requirements.txt", "requirements-dev.txt"])
    def test_has_pep263_cookie_or_bom(self, name: str):
        path = REPO_ROOT / name
        assert path.exists(), f"{name} 不存在"

        raw = path.read_bytes()
        has_bom = raw.startswith(b"\xef\xbb\xbf")

        head = b"\n".join(raw.split(b"\n")[:2]).decode("utf-8", "replace")
        has_cookie = any(token in head for token in _CODING_COOKIE)

        assert has_bom or has_cookie, (
            f"{name} 既没有 UTF-8 BOM 也没有 PEP 263 编码声明。\n"
            "pip < 25 会用 locale 编码读它（中文 Windows = cp936），"
            "文件里只要有中文注释就会 UnicodeDecodeError。\n"
            "修法：在**第一行**加 `# -*- coding: utf-8 -*-`。"
        )

    @pytest.mark.parametrize("name", ["requirements.txt", "requirements-dev.txt"])
    def test_is_valid_utf8(self, name: str):
        """顺带保证文件本身是合法 UTF-8（写坏了要早点发现）。"""
        (REPO_ROOT / name).read_bytes().decode("utf-8")


def _python_sources() -> list[Path]:
    files: list[Path] = []
    for sub in ("app", "tests"):
        files.extend(sorted((REPO_ROOT / sub).rglob("*.py")))
    return [f for f in files if "__pycache__" not in f.parts]


class TestSubprocessDecodesExplicitly:
    """`text=True` 不等于 UTF-8 —— 它等于「跟着 locale 走」。

    这个坑在中文 Windows 上会把「断言失败」变成「一个跟断言无关的 AttributeError」，
    排查成本高得多。凡是要读文本的，一律显式写 encoding。
    """

    SUBPROCESS_CALLS = {"run", "check_output", "check_call", "call", "Popen"}

    @staticmethod
    def _text_mode_without_encoding(tree: ast.AST) -> list[int]:
        offenders: list[int] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            # 匹配 subprocess.run(...) / subprocess.check_output(...)
            if not (
                isinstance(func, ast.Attribute)
                and func.attr in TestSubprocessDecodesExplicitly.SUBPROCESS_CALLS
                and isinstance(func.value, ast.Name)
                and func.value.id == "subprocess"
            ):
                continue

            kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}
            text_mode = any(
                k in kwargs and isinstance(kwargs[k], ast.Constant) and kwargs[k].value is True
                for k in ("text", "universal_newlines")
            )
            if text_mode and "encoding" not in kwargs:
                offenders.append(node.lineno)
        return offenders

    def test_no_text_mode_subprocess_without_encoding(self):
        offenders: list[str] = []
        for path in _python_sources():
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for lineno in self._text_mode_without_encoding(tree):
                rel = path.relative_to(REPO_ROOT).as_posix()
                offenders.append(f"{rel}:{lineno}")

        assert not offenders, (
            "这些 subprocess 调用用了 text=True 却没指定 encoding，"
            "在中文 Windows 上会按 cp936 解码而炸：\n  "
            + "\n  ".join(offenders)
            + "\n修法：加 encoding=\"utf-8\", errors=\"replace\"。"
        )


class TestSourcesAreValidUtf8:
    """源码里全是中文注释，一旦被某个编辑器存成 GBK 就会全线崩。"""

    def test_all_python_sources_decode_as_utf8(self):
        broken: list[str] = []
        for path in _python_sources():
            try:
                path.read_bytes().decode("utf-8")
            except UnicodeDecodeError as exc:
                broken.append(f"{path.relative_to(REPO_ROOT).as_posix()}: {exc}")
        assert not broken, "以下文件不是合法 UTF-8：\n  " + "\n  ".join(broken)
