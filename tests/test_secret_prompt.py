"""secret_prompt 的单元测试：rendezvous、权限、脱敏、清理。"""

from __future__ import annotations

import json
import os
import stat
import threading
import time
from pathlib import Path

import pytest

from circle import secret_prompt
from circle.secret_prompt import (
    SecretPromptError,
    SecretPromptTimeout,
    apply_to_target,
    collect,
    create_request,
    list_pending,
    poll_answer,
    requests_dir,
    submit_answer,
)


@pytest.fixture()
def home(tmp_path: Path) -> Path:
    return tmp_path / "circle-home"


def test_create_and_list_pending(home: Path) -> None:
    req = create_request(
        home, question="跳接机密码？", key="JUMPHOST_PASS", target_file="/tmp/x.env"
    )
    pending = list_pending(home)
    assert [p["id"] for p in pending] == [req["id"]]
    # 请求文件 600
    mode = stat.S_IMODE((requests_dir(home) / f"{req['id']}.request.json").stat().st_mode)
    assert mode == 0o600


def test_create_rejects_bad_key(home: Path) -> None:
    with pytest.raises(SecretPromptError):
        create_request(home, question="q", key="bad key!", target_file="/tmp/x.env")


def test_full_roundtrip_redacted(home: Path, tmp_path: Path) -> None:
    target = tmp_path / "env.d" / "env"
    secret_value = "root-password-不许泄漏"
    req = create_request(
        home, question="跳接机密码？", key="JUMPHOST_PASS", target_file=str(target)
    )

    def answer_later() -> None:
        time.sleep(0.3)
        submit_answer(home, req["id"], secret_value)

    threading.Thread(target=answer_later, daemon=True).start()
    value = poll_answer(home, req["id"], timeout_s=5)
    assert value == secret_value
    applied = apply_to_target(req, value)
    assert applied == target
    content = target.read_text(encoding="utf-8")
    assert content.strip() == f"JUMPHOST_PASS={secret_value}"


def test_apply_replaces_key_and_keeps_other_lines(home: Path, tmp_path: Path) -> None:
    target = tmp_path / "env"
    target.write_text("KMS_ADDR=10.4.127.100:8900\nAPV_PASSWORD=old\n", encoding="utf-8")
    req = create_request(
        home, question="设备密码？", key="APV_PASSWORD", target_file=str(target)
    )
    apply_to_target(req, "new-secret")
    text = target.read_text(encoding="utf-8")
    assert "KMS_ADDR=10.4.127.100:8900" in text
    assert "APV_PASSWORD=new-secret" in text
    assert "APV_PASSWORD=old" not in text
    assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_collect_returns_redacted_lines_only(home: Path, tmp_path: Path) -> None:
    target = tmp_path / "env"
    secret_value = "apv-enable-secret"

    def answer_later() -> None:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            pending = list_pending(home)
            if pending:
                submit_answer(home, pending[0]["id"], secret_value)
                return
            time.sleep(0.05)

    threading.Thread(target=answer_later, daemon=True).start()
    lines = collect(
        home,
        [{"question": "APV enable 密码", "key": "APV_ENABLE_PASSWORD",
          "target_file": str(target), "secret": True}],
        timeout_s=5,
    )
    joined = "\n".join(lines)
    assert secret_value not in joined
    assert "APV_ENABLE_PASSWORD" in joined
    assert str(target) in joined


def test_timeout_shreds_everything(home: Path, tmp_path: Path) -> None:
    req = create_request(
        home, question="q", key="K", target_file=str(tmp_path / "e")
    )

    def late_answer() -> None:
        # 与超时清理几乎同时提交：要么被"请求已失效"拒绝，要么写入后
        # 立刻被超时清理 shred——两种顺序都不得留下孤儿机密文件
        time.sleep(1.0)
        try:
            submit_answer(home, req["id"], "stale-secret")
        except SecretPromptError:
            pass

    threading.Thread(target=late_answer, daemon=True).start()
    with pytest.raises(SecretPromptTimeout):
        poll_answer(home, req["id"], timeout_s=0.6)
    time.sleep(1.3)  # 等迟到提交线程走完
    leftovers = [
        p for p in (requests_dir(home).iterdir() if requests_dir(home).is_dir() else [])
        if p.name != ".lock"
    ]
    assert leftovers == []


def test_answer_size_limit(home: Path) -> None:
    req = create_request(home, question="q", key="K", target_file="/tmp/e")
    with pytest.raises(SecretPromptError):
        submit_answer(home, req["id"], "x" * 5000)


def test_malformed_request_ignored(home: Path) -> None:
    directory = requests_dir(home)
    directory.mkdir(parents=True)
    (directory / "junk.request.json").write_text("{not json", encoding="utf-8")
    bogus = {"schema": "other", "id": "zz"}
    (directory / "zz.request.json").write_text(json.dumps(bogus), encoding="utf-8")
    assert list_pending(home) == []
