# Build extensions

An extension is a JavaScript or TypeScript module that adds to Circle without changing Circle itself. It can register tools, slash commands, middleware, subagents, and renderers for tool results, and it can react to events.

Extensions run inside the Circle process with your full user rights. Install only extensions you wrote or have read.

## Write one

Each extension is a folder with an `extension.mjs`, `extension.js` or `extension.ts` that exports a `register(api)` function:

```js
// ~/.circle/extensions/sample/extension.mjs
export function register(api) {
  const schema = {
    type: 'object',
    properties: { why: { type: 'string' }, x: { type: 'integer' } },
  };

  // An object is sent to the model as JSON.
  api.registerTool('echo_ro', 'Echo the arguments back. Read-only.', schema,
    (args) => ({ ok: true, echo: args }), { readOnly: true });
  api.registerTool('always_fails', 'Fails on purpose.', schema,
    (args) => { throw new api.ToolError('boom: ' + (args.why ?? '')); }, { readOnly: true });
  api.registerTool('writer', 'Changes something.', schema, () => 'written');
  api.registerCommand('hello', 'Say hello', (args, ctx) => ctx.toast('hello ' + args));
  api.registerRenderer('tool_result:echo_ro', (update) => ['ECHO ' + update.output]);
  api.on('turn_start', (payload) => {});
}
```

Start Circle and run `/extensions`. You should see the extension with its tool and command counts. `/hello world` prints `hello world`.

`register` may be `async`. If a folder has more than one of the three files, `extension.ts` is used first, then `extension.mjs`, then `extension.js`. Write it as an ES module (`export`, `import`). An `extension.ts` is loaded by Node's built-in type stripping: type annotations and interfaces work, but syntax that needs compiling, such as `enum`, `namespace` or constructor parameter properties, does not.

## Where extensions live

| Folder | When it loads |
|---|---|
| `~/.circle/extensions/<name>/` | Always |
| `<project>/.circle/extensions/<name>/` | When the project is [trusted](security.md#workspace-trust), which it must be for Circle to work in it |

A project extension replaces one of yours with the same name. Folder names use letters, digits, `_` and `-` (up to 64 characters, starting with a letter or digit); other folders, and folders without one of the three files, are skipped without a message.

Extensions are loaded at start, on `/reload` and on `/extensions reload`. Each load reads `extension.*` again, so an edit takes effect; a file it imports itself is not read again until Circle restarts. Extensions are not loaded in print mode, line mode or RPC mode.

To turn one off, set it in `settings.json`:

```json
"extensions": { "sample": { "enabled": false } }
```

## Coming from 0.5.0

Circle 0.5.0 and older loaded `extension.py`. This version does not run Python, and a folder with only an `extension.py` is skipped. Rewrite the extension as `extension.mjs` or `extension.ts`:

| 0.5.0 | Now |
|---|---|
| `register_tool(name, description, parameters, execute, read_only=…, approval=…)` | `registerTool(name, description, parameters, execute, { readOnly, approval })` |
| `register_command(name, description, handler)` with `ctx.send_user_message` | `registerCommand(name, description, handler)` with `ctx.sendUserMessage` |
| `register_middleware(middleware, slot)` with LangChain middleware | `registerMiddleware(handler, slot)` with a plain function, see [Middleware](#middleware) |
| `register_subagent(spec, tools)`, where `tools` named only extra tools | `registerSubagent(spec, tools)`, where `tools` is the whole list |
| `register_renderer(kind, renderer)` with `update.tool_output`, `update.is_error` | `registerRenderer(kind, renderer)` with `update.output`, `update.status` |
| `api.Watch(title, poll, interval_s=…, …)` | `new api.Watch(title, poll, { interval_s, … })`, and `poll` gets a cancel signal |

## The `api` object

| Member | Purpose |
|---|---|
| `api.name` | The extension's folder name. |
| `api.ToolError` | Throw it from a tool to report a failed call to the model. |
| `api.Watch` | `new api.Watch(title, poll, options)`: return it from a tool to have Circle wait for something slow. See [Waiting for something slow](#waiting-for-something-slow). |
| `registerTool(name, description, parameters, execute, options)` | Add a tool. |
| `registerCommand(name, description, handler)` | Add a slash command. |
| `registerMiddleware(handler, slot)` | Wrap model calls or tool calls. `slot` defaults to `tool_boundary`. |
| `registerSubagent(spec, tools)` | Add a subagent for `task`. |
| `registerRenderer('tool_result:<tool>', renderer)` | Change how a tool's result is shown. |
| `on(event, handler)` | React to `session_start`, `turn_start`, `turn_end` or `tool_result`. |

Any error while an extension loads (a bad name, a duplicate, an exception in `register`) turns that one extension off, removes everything it registered, and shows the reason in `/extensions`. Other extensions are not affected.

### Tools

- `name` uses letters, digits, `_` and `-`, up to 64 characters. It must not be one of Circle's built-in tools, an MCP tool, an earlier extension's tool, or another tool of your own.
- `parameters` is a JSON Schema object (`"type": "object"`). A call whose arguments do not fit it is refused before your code runs.
- `execute(args, context)` gets the arguments as an object and a context with `signal` (an `AbortSignal` that fires when the user presses `esc`), `sessionId` and `emitAttachments(items)`. It may be `async`. A string result is returned as is. Anything else is sent as JSON. Throw `api.ToolError('message')` to report failure; any other exception is reported to the model too, with secrets removed.
- `context.emitAttachments(items)` sends images or PDFs with the result. Each item has `kind` (`image` or `document`), `mime_type` (`image/png`, `image/jpeg`, `image/gif`, `image/webp` or `application/pdf`), `filename`, base64 `data` and the SHA-256 of the bytes as `sha256`. Items are checked and copied; a call that fails or is stopped sends none.
- The description is listed in the system prompt with the tool's name, and is the tool's description.
- `options.readOnly: true` marks a tool that changes nothing: it never asks and keeps working in `read-only` mode. Any other tool asks first, unless `options.approval` is `false`, and is refused in `read-only` mode. "Allow for this session" on its card covers every call to that tool.

### Waiting for something slow

A tool that starts something slow (a run on another machine, a sign-in the user finishes in a browser) can return an `api.Watch` instead of making the model call it again or `sleep`:

```js
api.registerTool('submit_run', 'Start a run and wait for it.', schema, async (args) => {
  const task = await startRun(args.case);
  return new api.Watch(`run ${args.case}`, async (signal) => {
    const status = await checkRun(task, { signal });
    return status.state === 'finished' ? status : null;
  }, { interval_s: 10, deadline_s: 2400, result: { task, state: 'pending' } });
});
```

- The tool call returns at once with `result` (text, or an object sent as JSON) and a note that Circle is watching it as a [background job](background-jobs.md).
- Circle calls `poll(signal)` every `interval_s` seconds (10 by default), off the model's turns. `null` or `undefined` means not yet. Any other value ends the job with that value as its result, and the model gets a notice with it (the last 4 KB; the whole result is in the job's output file). An exception, or `deadline_s` passing (3600 by default), fails the job.
- `signal` fires when the watch is stopped; pass it on to your requests. A `poll` that blocks without awaiting blocks all of Circle.
- `on_stop()` runs once if the job is stopped: by the model's `stop_job`, by `/jobs`, or because Circle is leaving, which waits up to two seconds for it.
- `poll` runs without asking again: the tool call that returned the watch was approved, or needed no approval.
- Watches count toward the 16 jobs that may run at once. A watch started by a subagent belongs to the conversation the subagent works for. Without a job list (an embedding that builds the agent itself), the tool call waits for the result instead.

### Commands

- `name` uses lowercase letters, digits, `_` and `-`, up to 32 characters, starting with a letter or digit, and must not be a built-in command or alias, a custom command, or another extension's.
- `handler(args, ctx)` gets the argument text and a context with `ctx.workspace`, `ctx.toast(text)` and `ctx.append(text)` (a line in the conversation that the model does not see), and `ctx.sendUserMessage(text)` (send a message as if you had typed it). It may be `async`.
- Extension commands do not run while a turn is running, are listed in `/help`, and are completed in the command list. An exception in the handler shows as `✖ /name failed: …`.

### Middleware

| Slot | Handler | What it can do |
|---|---|---|
| `model_call` | `async (request, next) => response` | Change the request (`request.system`, `request.messages`, `request.tools`) before calling `next(request)`, or change what it returns. |
| `tool_boundary` | `async (invocation, next) => text` | Run code around a tool call, after it was approved, and change the text it returns. `invocation` has `tool`, `args` and `context`; passing a different tool, arguments or context to `next` is refused. |
| `after_model` | `(response, request) => response \| undefined` | Look at each response; return a new one to replace it. |

Handlers of one slot run in the order they were registered, the first outermost. They apply to the main agent and its subagents.

### Subagents

`spec` is an object with a non-empty `name`, `description` and `system_prompt`, and an optional `model`, a model id on the same endpoint. `name` uses letters, digits, `_` and `-`. A subagent with the name of a built-in one (`general-purpose`, `explore`) or an earlier extension's replaces it.

`tools` lists the tools it gets, by name: built-in tools, MCP tools and extension tools. It gets exactly those, never `task`, `compact_conversation`, `plan_enter` or `plan_exit`. A name that does not exist skips that subagent, and `/extensions` says so. Its calls ask for approval like any other, and its system prompt is yours followed by the main agent's.

### Renderers

`renderer(update)` gets an object with `tool_name`, `tool_call_id`, `status` (`success` or `error`) and `output` (a string), and returns a list of lines. They replace the default result lines for that tool in the conversation. If it throws, or does not return a list of strings, the default is used and a red line says so. If two extensions register a renderer for the same tool, the first one loaded wins.

### Events

| Event | Payload |
|---|---|
| `session_start` | `{ workspace, session_id }`. Fires when extensions load (start, `/reload`, `/extensions reload`), and after `/new` and `/import`. |
| `turn_start` | `{ message, session_id }`. A turn Circle started for finished [background jobs](background-jobs.md) has no `message`. |
| `turn_end` | `{ answer, session_id, usage }`. Not sent for a turn that failed or was stopped. |
| `tool_result` | `{ id, name, status, output, session_id }`. |

Subagents' turns and tool results fire the same events. Handlers may be `async`. An exception is shown under the extension in `/extensions` and does not stop anything.

## Commands

| Command | What it does |
|---|---|
| `/extensions` (`/ext`) | List extensions with their tool and command counts, load errors and handler errors. |
| `/extensions reload` | Re-read settings, reconnect MCP servers and reload every extension. Not while a turn runs. |
