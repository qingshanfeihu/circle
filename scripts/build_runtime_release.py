"""Build a relocatable runtime release; no system Python is needed by users."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "dist-release")
    parser.add_argument("--python", default="3.13")
    parser.add_argument("--target-arch", choices=("arm64", "x86_64"))
    args = parser.parse_args()
    uv = shutil.which("uv")
    node = shutil.which("node")
    if not uv or not node:
        raise SystemExit("Build requires uv and Node >=22.19")
    os_tag = {"Darwin": "darwin", "Linux": "linux", "Windows": "windows"}[platform.system()]
    arch = {"aarch64": "arm64", "arm64": "arm64", "AMD64": "x86_64", "x86_64": "x86_64"}[platform.machine()]
    if args.target_arch:
        arch = args.target_arch
    args.out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="circle-release-") as temp:
        staging = (Path(temp) / "circle").resolve()
        staging.mkdir()
        runtime = staging / "runtime"
        python_dir = runtime / "python"
        run([uv, "python", "install", args.python, "--install-dir", str(python_dir), "--no-bin", "--no-registry"])
        candidates = list(python_dir.glob("*/python.exe")) if os_tag == "windows" else list(python_dir.glob("*/bin/python3*"))
        candidates = [p for p in candidates if p.is_file() and not p.name.endswith("-config")]
        if not candidates:
            raise RuntimeError("Managed runtime has no Python executable")
        python = candidates[0].resolve()
        run([uv, "build", "--wheel", "--out-dir", str(staging / "wheels")], cwd=ROOT)
        wheel = next((staging / "wheels").glob("circle-*.whl"))
        locked = staging / "requirements.lock.txt"
        run([uv, "export", "--frozen", "--all-extras", "--no-extra", "dev", "--no-dev", "--no-emit-project",
             "--output-file", str(locked)], cwd=ROOT)
        site = staging / "site-packages"
        run([uv, "pip", "install", "--python", str(python), "--target", str(site), "--require-hashes", "-r", str(locked)])
        run([uv, "pip", "install", "--python", str(python), "--target", str(site), "--no-deps", str(wheel)])
        run([shutil.which("npm"), "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=ROOT / "circle" / "node")
        shutil.copytree(ROOT / "circle" / "node" / "node_modules", site / "circle" / "node" / "node_modules")
        node_root = Path(node).resolve().parent if os_tag == "windows" else Path(node).resolve().parents[1]
        # Only vendor the runtime and npm; never bundle globally installed apps.
        def runtime_only(directory, names):
            folder = Path(directory)
            if folder == node_root / "lib" / "node_modules" or folder == node_root / "node_modules":
                return [name for name in names if name not in {"npm", "corepack"}]
            if folder == node_root / "bin":
                return [name for name in names if name not in {"node", "npm", "npx", "corepack"}]
            return []
        shutil.copytree(node_root, runtime / "node", symlinks=True, ignore=runtime_only)
        shutil.copy2(uv, runtime / ("uv.exe" if os_tag == "windows" else "uv"))
        # uv's version aliases may point at absolute installation paths. Make
        # every internal link relocatable before moving or archiving the tree.
        for link in staging.rglob("*"):
            if link.is_symlink():
                target = link.resolve(strict=False)
                if target.is_relative_to(staging):
                    relative = os.path.relpath(target, link.parent)
                    directory = target.is_dir()
                    link.unlink()
                    link.symlink_to(relative, target_is_directory=directory)
        manifest = {"version": json.loads((ROOT / "circle" / "node" / "package.json").read_text())["version"],
                    "platform": os_tag, "arch": arch,
                    "python_arch": subprocess.check_output([str(python), "-I", "-c", "import platform; print(platform.machine())"], text=True).strip(),
                    "python": str(python.relative_to(staging)),
                    "node": "runtime/node/node.exe" if os_tag == "windows" else "runtime/node/bin/node",
                    "uv": "runtime/uv.exe" if os_tag == "windows" else "runtime/uv",
                    "wheel": str(wheel.relative_to(staging)),
                    "wheel_sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
                    "node_version": subprocess.check_output([node, "--version"], text=True).strip(),
                    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()}
        (staging / "runtime.json").write_text(json.dumps(manifest, indent=2))
        notices = []
        for entry in site.glob("*.dist-info"):
            data = entry / "METADATA"
            if data.exists():
                notices.extend(line for line in data.read_text(errors="replace").splitlines()
                               if line.startswith(("Name:", "Version:", "License:", "License-Expression:")))
                notices.append("")
        (staging / "THIRD_PARTY_NOTICES.txt").write_text("\n".join(notices))
        shutil.copy2(ROOT / "packaging" / "runtime_launcher.py", staging / "launcher.py")
        relative_python = manifest["python"]
        if os_tag == "windows":
            (staging / "circle.cmd").write_text('@echo off\r\n"%~dp0' + relative_python.replace("/", "\\") + '" -I "%~dp0launcher.py" %*\r\n')
            command = [str(python), "-I", str(staging / "launcher.py")]
        else:
            executable = staging / "circle"
            executable.write_text('#!/bin/sh\nCIRCLE_RELEASE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$CIRCLE_RELEASE_ROOT/' + relative_python + '" -I "$CIRCLE_RELEASE_ROOT/launcher.py" "$@"\n')
            executable.chmod(0o755)
            command = [str(executable)]
        env = {**os.environ, "CIRCLE_HOME": str(Path(temp) / "smoke-home"), "LANGSMITH_TRACING": "false"}
        run([*command, "--version"], env=env)
        run([*command, "--list-models"], env=env, stdout=subprocess.DEVNULL)
        # Relocation is part of smoke, not inferred from the archive's layout.
        relocated = Path(temp) / "relocated with spaces"
        staging.rename(relocated)
        command = [str(relocated / relative_python), "-I", str(relocated / "launcher.py")]
        run([*command, "--version"], env=env)
        artifact = args.out / f"circle-{os_tag}-{arch}.tar.gz"
        with tarfile.open(artifact, "w:gz") as archive:
            archive.add(relocated, arcname="circle")
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        artifact.with_suffix(artifact.suffix + ".sha256").write_text(digest + "  " + artifact.name + "\n")
        print(artifact)


if __name__ == "__main__":
    main()
