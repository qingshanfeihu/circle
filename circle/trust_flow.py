"""Trust prompt before enabling a workspace."""

from __future__ import annotations

from pathlib import Path

from circle.paths import normalize_workspace
from circle.settings import CircleSettings
from circle.trust import accept_trust


def run_trust_prompt(
    settings: CircleSettings,
    workspace: str | Path,
    *,
    home: Path | None = None,
) -> CircleSettings | None:
    target = normalize_workspace(workspace)
    print("Circle 工作区信任")
    print(f"路径: {target}")
    print("Trust 后将：")
    print("  · 记入 ~/.circle/settings.json 的 trustedFolders")
    print("  · 在该目录创建 .agent/（项目级配置）")
    print("  · 以该目录为沙箱根进入主界面")
    raw = input("是否 trust 此文件夹? [y/N]: ").strip().lower()
    if raw not in {"y", "yes"}:
        print("未信任，退出。")
        return None
    return accept_trust(settings, target, home=home)
