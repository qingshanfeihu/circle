"""机密项收集的 rendezvous 机制（question 工具 secret 类型的落地层）。

为什么需要这个模块：聊天输入框的内容按定义就是 user message，必然进模型上下文；
跳转机/APV 密码绝不能走那条路。本模块用文件 rendezvous 把"提问"和"回答"拆到
两个线程，机密值的路径是：TUI 掩码输入 -> 答案文件(600) -> 目标 env 文件(600)，
全程不进对话、不进 tool result、不留明文临时文件。

流程：
1. 工具线程（question 工具）create_request() 写请求 JSON 到 <home>/secret_requests/
2. TUI 主循环发现待答请求，用户按 Ctrl+S 进入掩码输入（见 tui/session_app.py）
3. TUI submit_answer() 写答案文件（600）
4. 工具线程 poll_answer() 拿到值，apply_to_target() 追加 "KEY=value" 到目标文件，
   然后覆写销毁答案文件、删除请求文件
5. 工具返回给模型的只有脱敏确认文本

安全约定：
- 任何异常/超时路径都必须 shred 答案文件（机密不落地过夜）
- 目标文件按 600 写、所在目录按需 700 建
- 答案长度上限 _MAX_SECRET_BYTES，超出即拒
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Iterator, Mapping

SCHEMA = "circle.secret-request.v1"
_MAX_SECRET_BYTES = 4096
_POLL_INTERVAL_S = 0.5
_ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")


class SecretPromptError(Exception):
    """机密收集的可预期失败（消息可安全展示给模型/用户，不得含机密值）。"""


class SecretPromptTimeout(SecretPromptError):
    """等待用户输入超时；答案/请求文件已清理。"""


def requests_dir(home: Path | str) -> Path:
    return Path(home) / "secret_requests"


def _request_path(home: Path | str, request_id: str) -> Path:
    return requests_dir(home) / f"{request_id}.request.json"


def _answer_path(home: Path | str, request_id: str) -> Path:
    return requests_dir(home) / f"{request_id}.answer"


@contextlib.contextmanager
def _locked(home: Path | str) -> Iterator[None]:
    """跨线程互斥：提交答案与消费/清理答案必须串行，否则超时清理与
    迟到写入之间存在毫秒级竞态，会留下孤儿机密文件。"""
    directory = requests_dir(home)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".lock").open("a+b") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _shred(path: Path) -> None:
    """覆写后删除，避免机密残留在已释放的磁盘块上。"""
    try:
        size = path.stat().st_size
        with path.open("r+b") as fh:
            fh.write(b"\x00" * size)
            fh.flush()
            os.fsync(fh.fileno())
    except OSError:
        pass
    try:
        path.unlink()
    except OSError:
        pass


def create_request(
    home: Path | str,
    *,
    question: str,
    key: str,
    target_file: str,
    mask: bool = True,
) -> dict[str, Any]:
    """工具侧：创建待答请求。key 是写入目标文件时使用的 ENV 键名。"""
    key = (key or "").strip()
    if not _ENV_KEY_RE.match(key):
        raise SecretPromptError(f"非法 ENV 键名: {key!r}（仅限大写字母/数字/下划线）")
    if not (question or "").strip():
        raise SecretPromptError("机密提问文本不能为空")
    if not (target_file or "").strip():
        raise SecretPromptError("机密提问必须指定 target_file（写入目标）")
    rid = uuid.uuid4().hex
    directory = requests_dir(home)
    directory.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": SCHEMA,
        "id": rid,
        "created_at": time.time(),
        "question": question.strip()[:200],
        "key": key,
        "target_file": target_file,
        "mask": bool(mask),
    }
    path = _request_path(home, rid)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.chmod(path, 0o600)
    return payload


def list_pending(home: Path | str) -> list[dict[str, Any]]:
    """TUI 侧：列出全部待答请求，按创建时间升序（最旧的在前）。"""
    directory = requests_dir(home)
    if not directory.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for path in directory.glob("*.request.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("schema") == SCHEMA and data.get("id"):
            out.append(data)
    out.sort(key=lambda d: float(d.get("created_at") or 0))
    return out


def submit_answer(home: Path | str, request_id: str, value: str) -> None:
    """TUI 侧：写入答案（600）。值不进任何日志。

    请求文件必须仍在——工具超时后会删除请求，此时拒绝写入，
    避免"迟到答案"变成无人清理的孤儿机密文件。
    """
    with _locked(home):
        if not _request_path(home, request_id).is_file():
            raise SecretPromptError("机密请求已失效（可能已超时或被取消）")
        raw = value.encode("utf-8")
        if not raw:
            raise SecretPromptError("机密值不能为空")
        if len(raw) > _MAX_SECRET_BYTES:
            raise SecretPromptError("机密值超长")
        path = _answer_path(home, request_id)
        path.write_bytes(raw)
        os.chmod(path, 0o600)


def _consume_answer_locked(home: Path | str, request_id: str, path: Path) -> bytes | None:
    """持锁调用：消费答案文件（读后 shred）并删除请求。无答案返回 None。"""
    if not path.is_file():
        return None
    try:
        raw = path.read_bytes()
    except OSError:
        raw = b""
    finally:
        _shred(path)
    _request_path(home, request_id).unlink(missing_ok=True)
    return raw


def poll_answer(
    home: Path | str,
    request_id: str,
    *,
    timeout_s: float = 600.0,
) -> str:
    """工具侧：等待答案文件出现并读取；超时则清理请求+答案并抛 SecretPromptTimeout。"""
    deadline = time.monotonic() + timeout_s
    path = _answer_path(home, request_id)
    while time.monotonic() < deadline:
        with _locked(home):
            raw = _consume_answer_locked(home, request_id, path)
            if raw is not None:
                if not raw:
                    raise SecretPromptError("答案文件为空，已清理")
                return raw.decode("utf-8", errors="strict")
            if not _request_path(home, request_id).is_file():
                # TUI 侧取消或已清理
                raise SecretPromptError("机密提问已取消")
        time.sleep(_POLL_INTERVAL_S)
    with _locked(home):
        _shred(path)
        _request_path(home, request_id).unlink(missing_ok=True)
    raise SecretPromptTimeout(
        f"等待机密输入超时（{int(timeout_s)}s），请求已清理；如需继续请重新提问"
    )


def apply_to_target(request: Mapping[str, Any], value: str) -> Path:
    """把答案按 KEY=value 追加到目标 env 文件（600/700），返回目标路径。

    请求载荷由调用方持有（poll_answer 读到答案后即删除请求文件，不能回读）。
    """
    target = Path(str(request["target_file"])).expanduser()
    target_dir = target.parent
    if not target_dir.is_dir():
        target_dir.mkdir(parents=True)
        os.chmod(target_dir, 0o700)
    key = str(request["key"])
    existing: list[str] = []
    if target.is_file():
        existing = target.read_text(encoding="utf-8").splitlines()
    kept = [
        line for line in existing
        if not line.strip()
        or line.strip().startswith("#")
        or line.strip().partition("=")[0].strip() != key
    ]
    kept.append(f"{key}={value}")
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text("\n".join(kept) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)
    os.chmod(target, 0o600)
    return target


def collect(home: Path | str, questions: list[dict[str, Any]], *, timeout_s: float = 600.0) -> list[str]:
    """工具侧编排：为每个机密提问建请求 -> 等答案 -> 写入目标 -> 返回脱敏结果行。

    返回的字符串可安全进入模型上下文（不含机密值）。
    """
    results: list[str] = []
    for q in questions:
        request = create_request(
            home,
            question=str(q.get("question") or "").strip(),
            key=str(q.get("key") or "").strip(),
            target_file=str(q.get("target_file") or "").strip(),
        )
        value = poll_answer(home, request["id"], timeout_s=timeout_s)
        target = apply_to_target(request, value)
        results.append(f"  - {request['key']} → 已收集并写入 {target}（值未进入对话）")
    return results
