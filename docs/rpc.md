# RPC

Run `circle --mode rpc [folder]` and send one JSON command per input line. Standard output contains JSON response and event lines. A response echoes its command and non-null `id`, with `success` and either `data` or `error`.

```json
{"id":"1","type":"prompt","message":"Review src/cli.ts"}
{"type":"response","command":"prompt","success":true,"id":"1","data":{"disposition":"started"}}
```

| Command | Fields and result |
| --- | --- |
| `prompt`, `steer`, `follow_up` | `message`; returns `disposition`. A busy `prompt` requires `streamingBehavior: "steer"` or `"followUp"`. |
| `abort`, `clear_queue` | Abort waits for cancellation; clearing returns `steering` and `followUp` arrays. |
| `get_state` | Model, thinking level, streaming state, session identity/name and message/queue counts. |
| `get_messages` | Compatibility message envelopes: `{type: "human" | "ai" | "tool" | "system", data: {...}}`. |
| `get_native_messages` | Native messages, including attachment receipts and recorded prices. |
| `get_last_assistant_text`, `get_session_stats` | Last answer; persisted message, tool, token and price totals. |
| `new_session`, `set_session_name` | New session identity; rename with `name`. |
| `get_available_models`, `set_model` | Endpoint model names; select with `modelId`. |
| `set_thinking_level` | `level`; returns `thinkingLevel`, preserved across model changes. |
| `export_html` | `outputPath`; returns the written `path`. |
| `list_jobs`, `stop_job` | Process jobs; stop with `jobId` and return the settled `job`. `get_jobs` and `job_id` are accepted aliases. |
| `background` | Move the active foreground shell into a job; returns `moved`. |

Turns emit `turn_start`, `assistant`, `tool_result`, `turn_end` and `agent_settled`; cancellation emits `turn_end` with `aborted: true`. Jobs emit `{type: "job", event: "started" | "updated" | "ended", job: {...}}`. Job records contain `id`, `kind`, `title`, `status`, `reason`, `exitCode`, `startedBy`, numeric elapsed seconds, `output` and `sessionId`.

Closing input finishes the current turn and waits for model-owned jobs and their notice turns, up to `CIRCLE_JOB_WAIT` seconds (default 1800). After `abort`, notice turns remain suspended until another prompt. Remaining jobs stop before the final `jobs_stopped` event. Headless approval rules apply; ordinary effects require `--yolo`, and forced approvals stay blocked.
