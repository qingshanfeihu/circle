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
  "credential_files": []
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
| `auth.model` | string | `""` | The model id sent to the endpoint. `/models <name>` accepts any string without checking it. |
| `auth.api_key_ref` | string | `"api_key"` | The name of the key in `credentials.json`. |
| `auth.oauth_provider` | string | `""` | `anthropic` or `openai` when `mode` is `oauth`. |
| `trusted_folders` | list of strings | `[]` | Folders you have trusted. The match is exact: trusting `/a` does not trust `/a/b`. |
| `theme` | string | `"auto"` | `auto` follows your terminal, including when it switches between dark and light while Circle runs. `dark` or `light` overrides it, for a terminal that cannot be asked or answers wrongly. An older `terminal` means `auto`. `/themes` sets it. See [Dark and light terminals](interface.md#dark-and-light-terminals). |
| `mcp_servers` | list of objects | `[]` | MCP servers to connect. See [MCP](mcp.md). |
| `extensions` | object | `{}` | `{"name": {"enabled": false}}` turns an extension off. See [Extensions](extensions.md). |
| `credential_files` | list of strings | `[]` | File name patterns the model may not touch from the shell. See [Security](security.md#credential-files). |

## credentials.json

The API key is not in `settings.json`. It is in `credentials.json` next to it, a flat object of names and values:

```json
{ "api_key": "sk-..." }
```

`auth.api_key_ref` names which entry to use. Both files are readable only by you (mode `0600`).

## Before you edit by hand

- **Circle writes the file from memory.** Keys it does not know are dropped the next time it saves, and a hand edit made during a session is overwritten by that session's next save (`/models`, `/themes`, `/trust`, `/login`, `/logout`). Edit with Circle closed, or run `/reload` right after.
- **A malformed file stops Circle** at start with a traceback. Keep a copy before you edit.
- **`circle --init` starts from an empty settings object.** It resets `trusted_folders`, `mcp_servers`, `extensions`, `credential_files` and `theme`.

## Reloading

`/reload` re-reads `settings.json` and `credentials.json`, reloads extensions, and rebuilds the agent, which reconnects MCP servers and re-reads skills and instruction files. It applies `theme`. It does not re-read `credential_files`. It is refused while a turn is running.
