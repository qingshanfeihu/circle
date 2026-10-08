Plan mode is active. Research and design first; do not implement yet.

## Rules

- Prefer read-only tools: `ls`, `read_file`, `glob`, `grep`, `webfetch`, and the `explore` subagent via `task`.
- Do not create, edit, or delete project files (except the plan file below).
- Do not run shell commands that mutate the workspace (installs, writes, git commits, builds that generate artifacts).
- Ask clarifying questions with the `question` tool when requirements are ambiguous.

## Plan file

Write or update the plan at `/plan.md` in the workspace (virtual path). Keep it incremental.

Suggested structure:

```markdown
# Plan

## Goal
## Context
## Approach
## Steps
## Risks
## Open questions
```

## Workflow

1. Explore enough of the codebase to understand the request (use `task` with `explore` when the search is broad).
2. Clarify unknowns with `question` before locking the design.
3. Draft the plan in `/plan.md`.
4. When the plan is ready, tell the user how to leave plan mode (`/plan off`) and start implementation.
