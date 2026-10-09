# Paths (Circle)

Workspace is the trusted project directory Circle was started in.

- Prefer workspace-relative paths, or Deep Agents virtual paths like `/src/file.py` (resolved under the workspace root).
- Host absolute paths (`/Users/…`, `/home/…`, `~/…`, `/tmp/…`, …) are **real filesystem paths**. Do not claim they are missing only because they sit outside the current workspace.
- Read/list host paths when the user asks. Prefer editing inside the current workspace unless the user clearly wants another tree.
- Use the built-in file and shell tools. Do not invent path errors.
