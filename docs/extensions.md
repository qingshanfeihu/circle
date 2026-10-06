# Build extensions

An extension is a Python module that adds to Circle without changing Circle itself. It can register tools, slash commands, middleware, subagents, and renderers for tool results, and it can react to events.

Extensions run inside the Circle process with your full user rights. Install only extensions you wrote or have read.

## Write one

Each extension is a folder with an `extension.py` that defines `register(api)`:

```python
# ~/.circle/extensions/sample/extension.py
def register(api):
    schema = {
        "type": "object",
        "properties": {"why": {"type": "string"}, "x": {"type": "integer"}},
    }

    def echo(args):
        return {"ok": True, "echo": args}          # a dict is sent to the model as JSON

    def fails(args):
        raise api.ToolError("boom: " + str(args.get("why", "")))

    api.register_tool("echo_ro", "Echo the arguments back. Read-only.", schema, echo, read_only=True)
    api.register_tool("always_fails", "Fails on purpose.", schema, fails, read_only=True)
    api.register_tool("writer", "Changes something.", schema, lambda args: "written")
    api.register_command("hello", "Say hello", lambda args, ctx: ctx.toast("hello " + args))
    api.register_renderer("tool_result:echo_ro", lambda update: ["ECHO " + update.tool_output])
    api.on("turn_start", lambda payload: None)
```

Start Circle and run `/extensions`. You should see the extension with its tool and command counts. `/hello world` prints `hello world`.

## Where extensions live

| Folder | When it loads |
|---|---|
| `~/.circle/extensions/<name>/extension.py` | Always |
| `<project>/.circle/extensions/<name>/extension.py` | Only when the project is [trusted](security.md#workspace-trust) |

A project extension replaces a user extension with the same name. Folder names use letters, digits, `_` and `-` (up to 64 characters, starting with a letter or digit); other folders are skipped without a message. The extension's folder is not on `sys.path`, so add it yourself if you import a sibling file.

Extensions are loaded at start, on `/reload` and on `/extensions reload`. Trusting a project with `/trust` does not load its extensions until you reload. Extensions are not loaded in print mode or line mode.

To turn one off, set it in `settings.json`:

```json
"extensions": { "sample": { "enabled": false } }
```

## The `api` object

| Member | Purpose |
|---|---|
| `api.name` | The extension's folder name. |
| `api.ToolError` | Raise it from a tool to report a failed call to the model. |
| `register_tool(name, description, parameters, execute, *, read_only=False, approval=None)` | Add a tool. |
| `register_command(name, description, handler)` | Add a slash command. |
| `register_middleware(middleware, slot="tool_boundary")` | Add LangChain agent middleware. |
| `register_subagent(spec, tools=None)` | Add a subagent for `task`. |
| `register_renderer("tool_result:<tool>", renderer)` | Change how a tool's result is shown. |
| `on(event, handler)` | React to `session_start`, `turn_start`, `turn_end` or `tool_result`. |

Any error while an extension loads (a bad name, a duplicate, an exception in `register`) turns that one extension off, removes everything it registered, and shows the reason in `/extensions`. Other extensions are not affected.

### Tools

- `name` uses letters, digits, `_` and `-`, up to 64 characters. It must not be one of Circle's built-in tools, an earlier extension's tool, or another tool of your own.
- `parameters` is a JSON Schema object (`"type": "object"`).
- `execute(args)` gets the arguments as a dict. A `str` result is returned as is. Anything else is sent as indented JSON. Raise `api.ToolError("message")` to report failure. Any other exception is caught and reported to the model with secrets removed.
- The first sentence of `description` goes into the system prompt. The whole text is the tool's description.
- `approval` decides whether the tool asks first. By default a tool that is not `read_only` asks, and one that is `read_only` does not. Pass `approval=True` or `False` to say it yourself. `read_only` has no other effect: it does not stop the tool in `read-only` mode.
- An extension tool with the same name as an MCP tool is dropped without a message.

### Commands

- `name` uses lowercase letters, digits, `_` and `-`, up to 32 characters, and must not be a built-in command or alias, a custom command, or another extension's.
- `handler(args, ctx)` gets the argument text and a context with `ctx.workspace`, `ctx.toast(text)` (a line that stays in the conversation), `ctx.append(text)` (a raw line) and `ctx.send_user_message(text)` (start a turn as if you had typed it).
- Extension commands do not run while a turn is running, are listed in `/help`, and are tab-completed. An exception in the handler shows as `✖ /name failed`.

### Middleware

The slot only sets the order among extension middleware: `model_call`, then `tool_boundary`, then `after_model`. All of it is inserted as one block into the main agent, after Circle's own error, cancel, repair, prune and plan middleware and before the loop guard. Subagents do not get it.

### Subagents

`spec` is a dict with a non-empty `name`, `description` and `system_prompt`. A subagent with the name of a built-in one (`general-purpose`, `explore`) or an earlier extension's replaces it.

`tools` may name only the extra tools: `webfetch`, `question`, `skill`, `websearch`, `lsp`, `apply_patch`, MCP tools and extension tools. Naming anything else skips that subagent, and `/extensions` says so. An extension subagent always has the file and shell tools as well, whatever `tools` says, and its calls ask for approval like any other.

### Renderers

`renderer(update)` gets an object with `tool_name`, `tool_output` (a string), `tool_call_id` and `is_error`, and returns a list of lines. They replace the default result lines for that tool in the conversation. If it raises, or returns nothing, the default is used. If two extensions register a renderer for the same tool, the first one loaded wins.

### Events

| Event | Payload |
|---|---|
| `session_start` | `{"workspace": str}`. Fires when Circle starts and after `/new`, `/fork` and `/clone`. |
| `turn_start` | `{"text": str}`. |
| `turn_end` | `{"text": str}`, or `{"error": str}` when the turn failed. |
| `tool_result` | `{"tool": str, "output": str, "tool_call_id": str}`. |

Handlers run one after another on Circle's own thread. An exception is logged to `logs/circle.log` and does not stop anything.

## Commands

| Command | What it does |
|---|---|
| `/extensions` (`/ext`) | List extensions with their tool and command counts and any load errors. |
| `/extensions reload` | Re-read settings, reload every extension and rebuild the agent. Waits for the turn to end. |
