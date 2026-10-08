# How Circle works

Circle coordinates model requests, tool execution, approvals, context assembly and session storage. It is built on [deepagents](https://github.com/langchain-ai/deepagents), which sits on LangChain and LangGraph, and it adds its own terminal interface, safety policy and reliability layers.

## The agent loop

A message you send starts a turn. Circle builds a request from the system prompt, the conversation so far and the tool definitions, and sends it to your model endpoint. The model streams a reply that can contain text and tool calls.

Circle runs each tool call and adds the results to the conversation. If the model made tool calls, Circle sends another request. When the model answers without calling a tool, the turn ends and the footer shows what it cost.

Some tool calls stop the loop and wait for you. A command, a file change or a question from the model pauses the turn until you answer the card on screen. Circle then resumes exactly where it stopped. When several subagents ask at once, you answer them one after another and Circle resumes them all together.

`esc` cancels the current turn. Circle checks for the cancel at every model and tool boundary, and a shell command that is running is ended with everything it started. [Background jobs](background-jobs.md) are not touched: they go on, and Circle tells the model when one ends, starting a turn for it when nothing else runs.

## Tools

The main agent has nineteen built-in tools. See [Built-in tools](tools.md).

- Reading and searching: `ls`, `read_file`, `glob`, `grep`, `lsp`, `webfetch`, `websearch`
- Changing things: `write_file`, `edit_file`, `apply_patch`, `delete`, `execute`
- Working with you: `write_todos`, `question`
- Background jobs: `list_jobs`, `stop_job`
- Extending itself: `skill`, `task`, `compact_conversation`

MCP servers and [extensions](extensions.md) add more.

## Context

The model sees the conversation history and a system prompt that Circle assembles for every session. The prompt has these parts, in order:

1. Base instructions chosen by the model family (Claude, GPT, Gemini and others each get their own).
2. Circle's guidelines and a note on how paths work.
3. The list of available tools.
4. Your instruction files: `AGENTS.md` or `CLAUDE.md` from the workspace and its parent folders. See [Configuration](configuration.md#instruction-files).
5. A short description of the environment: working folder, platform, date, git, model.

[Skills](skills.md) add a short list of names and descriptions. The full text of a skill is read only when it is needed.

When the conversation passes 85% of the model's context window (from models.dev or `models` in settings, else 128,000), or sooner when the room kept for the answer needs it (see [Models](models.md#cost-and-context-in-the-footer)), Circle summarizes older messages automatically and keeps the most recent tenth. The full text of what was summarized is saved in the data folder (`projects/<folder>-<id>/conversation_history/`), not in your project. `/compact` does it on request. Older tool output outside a recent window is also replaced by a short stub in requests, so long sessions stay within budget. The stored conversation keeps the full output.

## Subagents

`task` starts a subagent with its own fresh context and returns its answer. Circle has two:

| Subagent | What it can do |
|---|---|
| `general-purpose` | The same file and shell tools as the main agent, without planning tools. Approvals apply to it exactly as to the main agent. |
| `explore` | Read-only: search and read files and the web. It never asks for approval. |

Several `task` calls in one message run at the same time. A strip below the input box shows each running subagent; `↓` selects one and `enter` opens its full record.

With `background: true` a subagent runs as a [background job](background-jobs.md#background-subagents): the turn goes on, and its report reaches the model when it ends. Its approvals show as cards of their own.

## Safety

Every session runs in a folder you have trusted. Commands and file changes ask first, and some commands are always refused. There are two modes you can switch on: `read-only` blocks all changes, and `auto` stops asking. None of this is an operating-system sandbox: a command you approve runs with your full user rights. Read [Security](security.md) before you rely on it.

## Sessions

A session is a conversation with its own history, saved in `checkpoints.sqlite` in your data folder. Circle also keeps a transcript for the screen. See [Sessions](sessions.md), including what does not carry over.

## Reliability

Circle protects a turn from the things that go wrong around a model:

- Transient endpoint errors are retried with backoff, honouring `Retry-After`.
- A parameter your endpoint rejects is dropped for the rest of the session.
- A stalled stream, a model stuck repeating itself, or a response with no finish signal is cut and sent again.
- A model that keeps repeating the same tool call, or keeps finding nothing, is reminded to change course.
- A tool that crashes returns an error to the model instead of ending the turn.
- A tool call with the wrong name case, spelling or argument shape is repaired when the meaning is clear.

Details and the settings that tune them are in [Choose a model](models.md#when-a-request-fails) and [Environment variables](environment-variables.md).

## Interfaces

The full-screen interface is the main way to use Circle. `circle -p` runs one prompt and prints the answer, and line mode reads prompts from a pipe; see [CLI](cli.md). All three use the same agent, the same folders and the same saved sessions.

## Extending Circle

[Skills](skills.md) add instructions on demand. [Custom commands](custom-commands.md) turn a Markdown file into a slash command. [MCP servers](mcp.md) add tools from other programs. [Extensions](extensions.md) are Python modules that add tools, commands, middleware, subagents and result renderers.
