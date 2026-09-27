"""Entrypoint executed by the release's own Python in isolated mode."""
import json
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
manifest = json.loads((root / "runtime.json").read_text())
os.environ["CIRCLE_NODE"] = str(root / manifest["node"])
os.environ["CIRCLE_UV"] = str(root / manifest["uv"])
os.environ["CIRCLE_WHEEL"] = str(root / manifest["wheel"])
os.environ["PATH"] = str((root / manifest["node"]).parent) + os.pathsep + os.environ.get("PATH", "")
sys.path.insert(0, str(root / "site-packages"))
from circle.cli import main

raise SystemExit(main())
