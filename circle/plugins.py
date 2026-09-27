"""Versioned plugin environments built by uv, activated after validation."""
from __future__ import annotations

import importlib
import json
import os
import shutil
import subprocess
import sys
import uuid
from importlib import metadata
from pathlib import Path


class PluginManager:
    def __init__(self, home: Path):
        self.root = home / "plugins"
        self.manifest = self.root / "installed.json"

    def read(self) -> dict:
        if not self.manifest.exists():
            return {"version": 1, "sources": [], "generation": None}
        return json.loads(self.manifest.read_text())

    def list(self) -> list[dict]:
        generation = self.read()["generation"]
        if not generation:
            return []
        return [{"name": dist.metadata["Name"], "version": dist.version,
                 "extensions": [ep.name for ep in dist.entry_points if ep.group == "circle.extensions"]}
                for dist in metadata.distributions(path=[str(self.root / generation)])
                if any(ep.group == "circle.extensions" for ep in dist.entry_points)]

    def reconcile(self, sources: list[str], *, preserve_versions: bool = False) -> None:
        uv = os.environ.get("CIRCLE_UV") or shutil.which("uv")
        if not uv:
            raise RuntimeError("uv is required to manage plugin dependencies")
        self.root.mkdir(parents=True, exist_ok=True)
        generation = "generation-" + uuid.uuid4().hex
        target = self.root / generation
        target.mkdir()
        constraints = target / "core-constraints.txt"
        host_versions = {dist.metadata["Name"]: dist.version for dist in metadata.distributions()
                         if dist.metadata["Name"] != "circle"
                         and not Path(dist.locate_file("")).resolve().is_relative_to(self.root.resolve())}
        if preserve_versions and self.read()["generation"]:
            active = self.root / self.read()["generation"]
            plugin_versions = {dist.metadata["Name"]: dist.version for dist in metadata.distributions(path=[str(active)])
                               if dist.metadata["Name"] != "circle"}
            host_versions = {**plugin_versions, **host_versions}
        constraints.write_text("\n".join(sorted(f'{name}=={version}' for name, version in host_versions.items())) + "\n")
        try:
            if sources:
                core = os.environ.get("CIRCLE_WHEEL")
                if core:
                    core = "circle @ " + Path(core).resolve().as_uri()
                else:
                    direct = metadata.distribution("circle").read_text("direct_url.json")
                    core = "circle @ " + json.loads(direct)["url"] if direct else None
                completed = subprocess.run([uv, "pip", "install", "--python", sys.executable,
                                            "--target", str(target), "--constraint", str(constraints),
                                            *([core] if core else []), *sources],
                                           capture_output=True, text=True, timeout=300, check=False)
                if completed.returncode:
                    from circle.middleware.redact import redact
                    raise RuntimeError(redact(completed.stderr[-1500:]))
            distributions = list(metadata.distributions(path=[str(target)]))
            names = [ep.name for dist in distributions for ep in dist.entry_points if ep.group == "circle.extensions"]
            if len(names) != len(set(names)):
                raise ValueError("Plugin extension names collide")
            if sources and not names:
                raise ValueError("Installed packages expose no circle.extensions entry points")
            payload = {"version": 1, "sources": sources, "generation": generation}
            temporary = self.manifest.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
            temporary.replace(self.manifest)
        except BaseException:
            shutil.rmtree(target)
            raise

    def install(self, source: str) -> None:
        sources = self.read()["sources"]
        replacing = source in sources
        if source not in sources:
            sources.append(source)
        self.reconcile(sources, preserve_versions=not replacing)

    def remove(self, source: str) -> None:
        sources = self.read()["sources"]
        if source not in sources:
            raise ValueError("Remove by the exact installed source")
        self.reconcile([item for item in sources if item != source], preserve_versions=True)

    def entry_points(self):
        generation = self.read()["generation"]
        if not generation:
            return []
        path = str(self.root / generation)
        # At an idle reload, remove previous plugin imports and paths. Otherwise
        # Python's module cache keeps executing the old generation after update.
        root = self.root.resolve()
        def owned(filename):
            return bool(filename) and Path(filename).resolve().is_relative_to(root)
        for name, module in list(sys.modules.items()):
            if owned(getattr(module, "__file__", None)):
                sys.modules.pop(name, None)
        sys.path[:] = [entry for entry in sys.path if not owned(entry)]
        importlib.invalidate_caches()
        if path not in sys.path:
            # Core modules take precedence; solver constraints prevent incompatible
            # plugin dependencies from replacing the host's framework versions.
            sys.path.append(path)
        return [ep for dist in metadata.distributions(path=[path])
                for ep in dist.entry_points if ep.group == "circle.extensions"]
