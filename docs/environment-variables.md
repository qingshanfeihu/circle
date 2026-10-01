# Environment variables

Circle reads a small number of environment variables. Most tune retries and guards and never need to be set.

The endpoint key is **not** read from the environment. Circle reads it only from `credentials.json`. See [Models](models.md).

## Location and mode

| Variable | Effect | Default |
|---|---|---|
| `CIRCLE_HOME` | Where Circle keeps settings, credentials, history and sessions. | `~/.circle` |
| `CIRCLE_NO_TUI` | `1`, `true` or `yes` forces [line mode](cli.md#full-screen-and-line-mode). | unset |
| `CIRCLE_NO_UPDATE_CHECK` | `1`, `true` or `yes` turns off the daily [update reminder](cli.md#the-reminder). | unset |
| `VISUAL`, `EDITOR` | Used by `/editor`. Falls back to `nvim`, `vim`, `nano`. | unset |

## Model requests

| Variable | Effect | Default |
|---|---|---|
| `CIRCLE_REASONING_EFFORT` | Thinking depth: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. On the Anthropic protocol Circle asks for `xhigh` unless you set this. On the OpenAI protocol nothing is sent unless you set it. | see left |
| `CIRCLE_LLM_TIMEOUT` | Request timeout in seconds. Minimum 5. | `45` |
| `CIRCLE_LLM_STALL_TIMEOUT` | Cut a stream that sends only keep-alive chunks for this many seconds. | `180` |
| `CIRCLE_LLM_REPEAT_GUARD` | `0`, `false`, `off` or `no` turns off the repetition guard. | on |
| `CIRCLE_LLM_VERIFY_FINISH` | Same values. Turns off the check for a response that ends without a finish reason. | on |
| `CIRCLE_MODEL_CTX` | Override the context window (in tokens) shown in the footer. | from the model name |

## Agent guards

| Variable | Effect | Default |
|---|---|---|
| `CIRCLE_LOOP_GUARD` | `0`, `false`, `no` or `off` turns off the loop guard. | on |
| `CIRCLE_LOOP_DUP_THRESHOLD` | Same tool call repeated this many times triggers a reminder. | `3` |
| `CIRCLE_LOOP_EMPTY_THRESHOLD` | This many empty results in a row triggers a reminder. | `4` |
| `CIRCLE_LOOP_SOFT_BUDGET` | Tool calls in one turn before a soft note. | `25` |
| `CIRCLE_LOOP_WINDOW` | Minimum model replies between reminders. | `8` |
| `CIRCLE_PRUNE_TOOL_OUTPUTS` | `0`, `false`, `no` or `off` turns off pruning of old tool output. | on |
| `CIRCLE_PRUNE_PROTECT_TOKENS` | How much recent output stays untouched by pruning. | `40000` |

## Terminal

| Variable | Effect | Default |
|---|---|---|
| `CIRCLE_TUI_SHIMMER` | `0` turns off the rainbow animation. | on |
| `CIRCLE_TUI_SHIMMER_MS` | Animation frame time in milliseconds, 33 to 500. | `80` |
| `COLORFGBG` | Light or dark fallback when the terminal does not answer the colour query. | unset |
| `TMUX`, `STY` | Circle wraps its escape sequences for tmux and screen. | set by them |
| `SSH_CONNECTION` | Selection copy uses OSC 52 instead of a local clipboard tool. | set by SSH |

## Variables Circle sets

At start, and after `/login`, `/models` and `/reload`, Circle exports these from your settings so the model SDKs can find them:

- `OPENAI_BASE_URL` and `OPENAI_API_KEY` for the OpenAI protocol, or `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` for the Anthropic protocol
- `CIRCLE_MODEL`

`/logout` removes all five. Commands the model runs in the shell get a filtered copy of the environment: any variable whose name contains a word such as `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` is removed, so the API key does not reach them. `OPENAI_BASE_URL` and `CIRCLE_MODEL` do.

## Installer and updates

| Variable | Read by | Effect |
|---|---|---|
| `CIRCLE_REPO` | `install.sh`, `install.ps1`, `circle update` | The GitHub repository to take releases from. Default `qingshanfeihu/circle`. |
| `CIRCLE_VERSION` | `install.sh`, `install.ps1` | Install this version instead of the newest, for example `0.2.0`. |
| `CIRCLE_PREFIX` | `install.sh`, `install.ps1` | Where versions are kept. Default `~/.local/share/circle`, or `%LOCALAPPDATA%\circle` on Windows. |
| `CIRCLE_BIN_DIR` | `install.sh` | Where the `circle` link goes. Default `~/.local/bin`. |
| `CIRCLE_NO_PATH` | `install.ps1` | `1` leaves your `PATH` alone. |
| `CIRCLE_FROM_SOURCE` | `install.sh` | `1` runs `pip install -e` on the checkout instead of downloading. |
| `CURL_CA_BUNDLE` | `install.sh` (through curl) | A PEM file of certificate authorities, for a network that inspects HTTPS. |
| `SSL_CERT_FILE` | `circle update` | The same, for Circle's own requests. |
| `HTTPS_PROXY` | all three | A proxy for the download. |

See [Quickstart](quickstart.md#1-install) and [Updating](cli.md#updating).
