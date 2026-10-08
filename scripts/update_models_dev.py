#!/usr/bin/env python3
"""Refresh the models.dev snapshot that ships with Circle.

    python scripts/update_models_dev.py              fetch https://models.dev/api.json
    python scripts/update_models_dev.py api.json     use a file saved before

Writes ``circle/data/models_dev.json.gz``: for each provider its API address and, per model,
the context window, the output limit and the prices (``circle.model_catalog.slim``). Run it
before a release so a Circle without network access still knows recent models.
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from circle.model_catalog import SNAPSHOT, fetch, slim  # noqa: E402


def main(argv: list[str]) -> int:
    raw = json.loads(Path(argv[0]).read_text(encoding="utf-8")) if argv else fetch(timeout=60)
    data = slim(raw)
    providers = data["providers"]
    if not providers:
        print("models.dev gave no providers; snapshot left as it was", file=sys.stderr)
        return 1
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0: the same data gives the same bytes, so an unchanged snapshot makes no diff
    SNAPSHOT.write_bytes(gzip.compress(text.encode("utf-8"), mtime=0))
    models = sum(len(p["models"]) for p in providers.values())
    print(f"{SNAPSHOT.relative_to(ROOT)}: {len(providers)} providers, {models} models, "
          f"{SNAPSHOT.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
