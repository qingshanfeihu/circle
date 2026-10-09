# Extensions

An extension adds tools, commands, middleware, subagents, renderers and event handlers. Put an `extension.ts`, `extension.mjs` or `extension.js` in its own folder under the data folder's `extensions/`, or under `.circle/extensions/` in a trusted project. Project extensions replace account extensions with the same folder name.

```ts
export function register(api) {
  api.registerTool(
    'inspect_project',
    'Inspect the project.',
    { type: 'object', properties: {} },
    async (_args, context) => {
      context.signal.throwIfAborted();
      return { ok: true };
    },
    { readOnly: true },
  );
  api.registerCommand('inspect', 'Inspect the project', (_args, context) => {
    context.sendUserMessage('Inspect the project');
  });
}
```

Exports and registration may be asynchronous. A failed registration is discarded as a unit and reported by `/extensions`. Disable a folder with `"extensions": { "name": { "enabled": false } }` in settings. `/extensions reload` reloads only when the current turn is idle. Headless modes do not load extensions.

## API

- `registerTool(name, description, parameters, execute, options)`: JSON Schema parameters; string results remain text, other results become JSON. Tools require approval unless read-only or explicitly configured with `approval: false`. Read-only mode still blocks mutating and unknown effects.
- A tool context provides `emitAttachments(items)` for image/PDF output alongside the returned text. Each item contains `kind` (`image` or `document`), `mime_type`, `filename`, canonical base64 `data` and the bytes' SHA-256 `sha256`. Emitted attachments are validated and copied; a failed or cancelled call discards them. MCP image and embedded PDF results use the same channel.
- `registerCommand(name, description, handler)`: receives `workspace`, `toast`, `append` and `sendUserMessage` in its context. Built-in and custom-command names are reserved.
- `registerMiddleware(handler, slot)`: `model_call` receives `(request, next)`, `tool_boundary` receives `(invocation, next)`, and `after_model` receives `(response, request)`. Tool middleware cannot replace an approved invocation.
- `registerSubagent(spec, toolNames)`: spec contains `name`, `description` and `system_prompt`, with optional `model`. Missing tool names disable that agent with a warning. Later agents of the same name replace earlier agents, including bundled agents.
- `registerRenderer('tool_result:name', renderer)`: returns transcript lines from a result containing `tool_name`, `tool_call_id`, `status` and `output`. Invalid or failed renderers fall back to the normal result view.
- `on(event, handler)`: observes `session_start`, `turn_start`, `turn_end` or `tool_result`. Handler failures are isolated and shown in extension status.
- `new api.Watch(title, poll, options)`: return it from a tool to create a background watch. Options are `interval_s` (default 10), `deadline_s` (default 3600), `result` and `on_stop`.

## Waiting for slow work

```ts
return new api.Watch('remote build', async (signal) => {
  const response = await fetch(statusUrl, { signal });
  const status = await response.json();
  return status.finished ? status : null;
}, {
  interval_s: 5,
  deadline_s: 1800,
  result: { state: 'pending' },
  on_stop: () => stopOwnedRequest(),
});
```

The tool returns its initial result and job id immediately. Polling runs asynchronously between model steps; `null` or `undefined` means pending, and any other value completes the watch. Exceptions and deadlines fail the job. The result is retained in its output file; completion notices carry bounded text and the file path.

`poll(signal)` should forward cancellation to its network requests or other owned operations. `on_stop` runs once when the watch is stopped, times out or the application closes; cleanup waits up to two seconds. Synchronous blocking callbacks still block Node's event loop. Watches share the shell/watch capacity limit and inherit the calling child agent's owner. An embedding without a job registry waits for the result instead.

Raise `new api.ToolError('message')` for a failed tool result. Extension code executes with the application's privileges; workspace trust is required before loading project code. Existing Python extensions must be rewritten in TypeScript or JavaScript.
