# RPC mode

`circle --mode rpc [folder]` runs Circle as a child process for another program, such as an editor. It reads one JSON command per line on standard input and writes JSON lines to standard output until its input closes. The commands follow pi's RPC mode where Circle has the same thing.

```bash
circle --mode rpc ~/code/app
```

Each command gets one `response` line, with the command's `id` when it had one:

```json
{"id": "1", "type": "prompt", "message": "Review src/app.ts"}
{"type": "response", "command": "prompt", "success": true, "id": "1", "data": {"disposition": "started"}}
```

A command that fails has `"success": false` and an `error`. A line that is not a JSON object gets a `response` with `"command": "parse"`. Empty lines are skipped.

## Commands

| `type` | Fields | What it does |
|---|---|---|
| `prompt` | `message`, `streamingBehavior` | Start a turn. While one runs, `streamingBehavior` must be `steer` (the model reads it before its next step) or `followUp` (sent when the turn ends). `data.disposition` is `started` or `queued`. |
| `steer` | `message` | A steering message for the running turn, or a new turn when none runs. |
| `follow_up` | `message` | A message for after the running turn, or a new turn when none runs. |
| `abort` | | Stop the running turn and drop the waiting messages; answers once the turn has stopped. |
| `clear_queue` | | Take back the waiting messages: `data.steering` and `data.followUp`. |
| `new_session` | | A new conversation: `data.sessionId`. Not while a turn runs. |
| `get_state` | | `model`, `thinkingLevel`, `isStreaming`, `sessionId`, `sessionName`, `messageCount`, `pendingMessageCount`. |
| `get_messages` | | Every message, as `{"type": "human" \| "ai" \| "tool" \| "system", "data": {...}}`, the shape LangChain message dicts have. |
| `get_native_messages` | | Every message as Circle stores it, with attachments and the recorded price of each call. |
| `get_last_assistant_text` | | `data.text`. |
| `get_session_stats` | | `sessionId`, `userMessages`, `assistantMessages`, `toolCalls`, `toolResults`, `totalMessages`, `tokens` (`input`, `output`, `total`) and `costs`. Subagents and compactions are counted. |
| `set_session_name` | `name` | Give the conversation a title. |
| `get_available_models` | | `data.models`: what the endpoint lists. |
| `set_model` | `modelId` | Use another model for the rest of the process: `data.model`. Not while a turn runs. |
| `set_thinking_level` | `level` | `minimal` … `max`, for the rest of the process, also after `set_model`: `data.thinkingLevel`. Not while a turn runs. |
| `export_html` | `outputPath` | Write the conversation as HTML: `data.path`. A relative path is inside the workspace; the default is `<session id>.html` there. |
| `list_jobs` | | Every background job of the process: `data.jobs`, each as in the `job` event. `get_jobs` works too. |
| `stop_job` | `jobId` | Stop a running job with everything it started: `data.job`. `job_id` works too. |
| `background` | | Move the command being waited on to the background, as `ctrl+b` does: `data.moved`, how many. |

## Events

The work a prompt starts is written as the [JSON events](cli.md#json-events) of print mode, without `session`. On top of those:

| `type` | When |
|---|---|
| `steer` | The model read a steering message (`message`). |
| `turn_end` with `"aborted": true` | The turn was stopped by `abort` or `ctrl+c`. |
| `agent_settled` | The work a prompt or a job notice started has ended, and nothing more will run on its own. |
| `jobs_stopped` | The last line: `count`, the jobs that were still running at the end and were stopped. |

When a [background job](background-jobs.md) the model started ends while nothing runs, Circle starts a turn for it, up to ten in a row. Its `turn_start` has no `message`, and it also ends with `agent_settled`. After `abort` or `new_session` such turns wait for the next prompt.

## Options and approvals

`--model`, `--thinking`, `--tools`, `--exclude-tools`, `--no-tools`, `--system-prompt`, `--append-system-prompt`, `--no-context-files`, `--name`, `--session`, `--session-id`, `--fork`, `-c`, `--no-session` and `--yolo` apply as usual. Messages and `@files` on the command line are refused, and so are `-r` and `--line`: send prompts as commands.

Nobody can answer an approval card, so calls are decided as in [print mode](cli.md#print-mode): without `--yolo`, a call that would ask is not run and the model is told why; with `--yolo` it runs, except the calls that always ask. A question from the model comes back to it as text to ask in its answer. MCP servers, extensions and custom commands are not loaded. The folder must be trusted and Circle set up already; see [Print mode](cli.md#print-mode).

## When the input closes

Closing standard input lets the current turn finish. Processes a command left running are stopped. Then Circle waits for the jobs the model started, as print mode does: when one ends the model gets its notice and a turn, up to `CIRCLE_JOB_WAIT` seconds (1800 by default) and ten turns, and not at all after an `abort`. It stops what still runs, writes `jobs_stopped`, and exits with code `0`, or `130` after `ctrl+c`.
