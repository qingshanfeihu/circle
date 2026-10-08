# Settings

Circle keeps its settings in `settings.json` inside the data folder (`~/.circle` unless you set `CIRCLE_HOME`). Setup creates it. You can edit it by hand.

Read [Before you edit by hand](#before-you-edit-by-hand) first.

```json
{
  "version": 1,
  "initialized": true,
  "auth": {
    "mode": "api_key",
    "protocol": "openai",
    "base_url": "https://gateway.example/v1",
    "model": "my-model",
    "api_key_ref": "api_key",
    "oauth_provider": ""
  },
  "trusted_folders": ["/Users/me/code/my-project"],
  "theme": "terminal",
  "mcp_servers": [],
  "extensions": {},
  "credential_files": [],
  "update_check": true
}
```

## Keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `version` | number | `1` | Settings format. Not used yet. |
| `initialized` | boolean | `false` | Set by setup. `/logout` sets it back to `false`, and the next start shows setup. |
| `auth.mode` | string | `"api_key"` | `api_key` or `oauth`. Only `api_key` works today. See [Models](models.md#oauth). |
| `auth.protocol` | string | `"openai"` | `openai` or `anthropic`. It decides which client talks to the endpoint. Circle never guesses it from the model name. |
| `auth.base_url` | string | `""` | The endpoint. For OpenAI style, include `/v1`. For Anthropic style, give the gateway root. |
| `auth.model` | string | `""` | The model id sent to the endpoint, the default for new sessions. `ctrl+s` in `/models` sets it. |
| `auth.api_key_ref` | string | `"api_key"` | The name of the key in `credentials.json`. |
| `auth.oauth_provider` | string | `""` | `anthropic` or `openai` when `mode` is `oauth`. |
| `default_thinking` | string | `""` | The thinking depth to start with: `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Empty means the protocol's default. `CIRCLE_REASONING_EFFORT` wins over it. `ctrl+s` in `/effort` sets it. See [Models](models.md#thinking-depth). |
| `enabled_models` | list of strings | `[]` | The models `ctrl+p` switches between. Each entry is a model id or a pattern such as `step-*`, matched against what the endpoint lists. Empty means every listed model. |
| `double_escape` | string | `"tree"` | What `esc` twice on an empty input box opens: `tree` (the session tree), `fork` (the fork list) or `none`. `/settings` changes it. |
| `hide_thinking` | boolean | `false` | Start sessions with the model's thinking rows hidden. `/thinking` shows them for a session; `/settings` changes the default. |
| `trusted_folders` | list of strings | `[]` | Folders you have trusted. The match is exact: trusting `/a` does not trust `/a/b`. |
| `theme` | string | `"auto"` | `auto` follows your terminal, including when it switches between dark and light while Circle runs. `dark` or `light` overrides it, for a terminal that cannot be asked or answers wrongly. An older `terminal` means `auto`. `/themes` sets it. See [Dark and light terminals](interface.md#dark-and-light-terminals). |
| `mcp_servers` | list of objects | `[]` | MCP servers to connect. See [MCP](mcp.md). |
| `extensions` | object | `{}` | `{"name": {"enabled": false}}` turns an extension off. See [Extensions](extensions.md). |
| `credential_files` | list of strings | `[]` | File name patterns the model may not touch from the shell. See [Security](security.md#credential-files). |
| `models` | object | `{}` | Per model: `{"glm-5.3": {"context_window": 1000000}}` sets the context window the footer shows and the automatic compaction uses, in place of the one from models.dev. When the model asks for an answer limit, it is held to a quarter of it; [Models](models.md#cost-and-context-in-the-footer) says where compaction starts. `CIRCLE_MODEL_CTX` sets one window for every model. |
| `update_check` | boolean | `true` | Once a day, when the full-screen interface starts, ask GitHub whether a newer release exists and say so in one line. `false` turns it off. See [Updating](cli.md#updating). |

## Project settings

A project can set a few things for its folder in `.circle/settings.json`, as pi's `.pi/settings.json` does:

```json
{"model": "step-5-preview", "default_thinking": "high", "credential_files": ["*.pem"]}
```

Only these keys are read: `model`, `default_thinking`, `enabled_models`, `double_escape`, `hide_thinking`, `theme` and `credential_files`. They apply while Circle works in that folder (sessions, `-p`, line mode and RPC mode) and are never written to your `settings.json`. `credential_files` is added to yours, so a project can protect more files but not fewer. The endpoint, the key, MCP servers, extensions and trusted folders cannot be set by a project; a key Circle does not take is named in red at start (on standard error without the full-screen interface).

When you change one of these in a session (`/themes`, `/settings`, `ctrl+s` in `/models` or `/effort`, `tab` in `/models`), your choice is saved as yours and used from then on in this session.

## credentials.json

The API key is not in `settings.json`. It is in `credentials.json` next to it, a flat object of names and values:

```json
{ "api_key": "sk-..." }
```

`auth.api_key_ref` names which entry to use. Both files are readable only by you (mode `0600`).

## Before you edit by hand

- **Circle writes the file from memory.** Keys it does not know are kept, but a hand edit made during a session is overwritten by that session's next save (`ctrl+s` in `/models` or `/effort`, `/themes`, `/trust`, `/login`, `/logout`). Edit with Circle closed, or run `/reload` right after.
- **A malformed file stops Circle** at start with a traceback. Keep a copy before you edit.
- **`circle --init` replaces only the connection**: `auth` (endpoint, protocol, model). It also clears `enabled_models` when the endpoint changes. See [CLI](cli.md#setting-up-again).

## Reloading

`/reload` re-reads `settings.json` and `credentials.json`, reloads extensions, and rebuilds the agent, which reconnects MCP servers and re-reads skills and instruction files. It applies `theme`. It does not re-read `credential_files`. It is refused while a turn is running.
