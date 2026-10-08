# Background jobs

Run a command with `execute({ command: "npm test", background: true })`, or a subagent with `task({ description: "Inspect the parser", background: true })`. The call returns a job id such as `j1` and an output path. A completion notice supplies the result; the model does not need to poll or sleep.

## Commands and output

Press **Ctrl+B** to move a command being waited on into the background. Commands that reach the default 120-second timeout also continue as jobs. An explicit foreground `timeout` ends the command instead; explicit background timeouts permit up to 24 hours.

`/jobs` lists jobs. Enter opens a page with refreshed output; Esc returns to the list. On a job's page, Ctrl+D asks before stopping a running job or removes a completed entry. `list_jobs` and `stop_job` are model tools. Subagents also have `wait_jobs`.

Output is stored outside the workspace under `projects/<project>/background_jobs/<run>/`, readable through `/background_jobs/<run>/<file>`. File tools cannot change these logs. stdout and stderr share a file, retaining complete bytes and write order. The default output limit is 1 GiB per job; set `CIRCLE_JOB_OUTPUT_LIMIT_MB` to change it. There may be 16 background shell jobs and four background subagents.

## Completion and shutdown

Completion notices are appended to the owning conversation before its next model request. The TUI and RPC can resume an idle conversation with a notice. Interrupting a turn suppresses automatic wakeups until another message; stopped jobs do not wake the model. Background question and approval cards wait while the foreground turn or your input owns the interface.

Print mode waits for job results for `CIRCLE_JOB_WAIT` seconds (default 1800; `0` disables waiting). Line mode reads notices with the next message. Automatic wakeups stop after ten consecutive turns.

Leaving stops jobs and records their cancellation in affected conversations. Terminal termination signals also clean up jobs. Reopening a conversation retains notices and never reruns commands. Old output folders are removed after a day when their owning process has ended.

Extension tools can return a [Watch](extensions.md#waiting-for-slow-work) for asynchronous status checks. A bare foreground `sleep` ends when a job in its conversation finishes; commands containing other work continue normally. Repeated polling prompts a reminder to await the automatic notice. After compaction, a hidden reminder names running jobs omitted from the summary.

Process groups on macOS/Linux and `taskkill /T` on Windows cover ordinary subprocess trees. Detached daemons and forcibly killing the application remain outside this guarantee. Windows adoption of processes whose shell has already exited and remaining interaction parity are tracked in [known issues](known-issues.md).
