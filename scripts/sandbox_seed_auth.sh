#!/usr/bin/env bash
# Seed sandbox CIRCLE_HOME for API URL+KEY (no secrets in git).
#
#   CIRCLE_API_URL=... CIRCLE_API_KEY=... [CIRCLE_MODEL=...] \
#     ./scripts/sandbox_seed_auth.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="${CIRCLE_SANDBOX:-$ROOT/../circle-sandbox}"
export HOME_DIR="${CIRCLE_HOME:-$SANDBOX/home}"
export WS="${CIRCLE_WORKSPACE:-$SANDBOX/workspace}"
export URL="${CIRCLE_API_URL:?set CIRCLE_API_URL}"
export KEY="${CIRCLE_API_KEY:?set CIRCLE_API_KEY}"
export MODEL="${CIRCLE_MODEL:-gpt-4.1}"
export PROTOCOL="${CIRCLE_PROTOCOL:-openai}"

mkdir -p "$HOME_DIR" "$WS"
python3 - <<'PY'
import json, os
from pathlib import Path
home = Path(os.environ["HOME_DIR"])
ws = Path(os.environ["WS"]).resolve()
settings = {
    "version": 1,
    "initialized": True,
    "auth": {
        "mode": "api_key",
        "protocol": os.environ["PROTOCOL"],
        "base_url": os.environ["URL"].rstrip("/"),
        "model": os.environ["MODEL"],
        "api_key_ref": "api_key",
        "oauth_provider": "",
    },
    "trusted_folders": [str(ws)],
    "theme": "terminal",
    "mcp_servers": [],
}
(home / "settings.json").write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
(home / "credentials.json").write_text(
    json.dumps({"api_key": os.environ["KEY"]}, indent=2) + "\n", encoding="utf-8"
)
os.chmod(home / "settings.json", 0o600)
os.chmod(home / "credentials.json", 0o600)
agent = ws / ".agent"
agent.mkdir(parents=True, exist_ok=True)
(agent / "README.md").write_text("# Circle sandbox workspace\n", encoding="utf-8")
print(f"seeded {home}/settings.json")
print(f"trusted {ws}")
PY
