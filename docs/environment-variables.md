# Environment variables

Circle reads a small number of environment variables. Most tune retries and guards and never need to be set.

The endpoint key is **not** read from the environment. Circle reads it only from `credentials.json`. See [Models](models.md).

## Location and mode

| Variable | Effect | Default |
|---|---|---|
| `CIRCLE_HOME` | Where Circle keeps settings, credentials, history and sessions. | `~/.circle` |
| `CIRCLE_HISTORY_PATH` | The file your prompt history is kept in. | `history` in the data folder |
| `CIRCLE_NO_TUI` | `1`, `true` or `yes` forces [line mode](cli.md#full-screen-and-line-mode). | unset |
| `CIRCLE_NO_UPDATE_CHECK` | `1`, `true`, `yes` or `on` turns off the daily [update reminder](cli.md#the-reminder). | unset |
| `VISUAL`, `EDITOR` | Used by `ctrl+g` and `/editor`, in that order. May include arguments, such as `code --wait`. | `vi`, or `notepad` on Windows |

## Background jobs

| Variable | Effect | Default |
|---|---|---|
| `CIRCLE_JOB_WAIT` | How many seconds print mode (and RPC mode, when its input ends) waits after its answer for [background jobs](background-jobs.md) the model started. What still runs then is stopped. `0` does not wait. | `1800` |
| `CIRCLE_JOB_OUTPUT_LIMIT_MB` | A background job that writes more output than this is stopped. Also applies to a command in the foreground. | `1024` |

## Model requests

| Variable | Effect | Default |
|---|---|---|
| `CIRCLE_REASONING_EFFORT` | Thinking depth: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Wins over `default_thinking`; `--thinking` sets it for one run. | Anthropic protocol: `xhigh`; OpenAI protocol: nothing sent |
| `CIRCLE_LLM_TIMEOUT` | Request timeout in seconds. Minimum 5. | `45` |
| `CIRCLE_LLM_STALL_TIMEOUT` | Cut a stream that has sent nothing but keep-alives for this many seconds. `0` turns it off. | `180` |
| `CIRCLE_LLM_REPEAT_GUARD` | `0`, `false`, `off` or `no` turns off the repetition guard. | on |
| `CIRCLE_LLM_VERIFY_FINISH` | Same values. Turns off the check for a response that ends without a finish reason. | on |
| `CIRCLE_MODEL_CTX` | The context window in tokens for every model (`1000000` or `1_000_000`): the footer's `ctx` and where the automatic compaction starts. `models` in `settings.json` sets one model's and wins. | from models.dev |
| `CIRCLE_NO_MODELS_REFRESH` | Set to anything to stop the daily background fetch of models.dev. The snapshot shipped with Circle, or the last copy fetched, is used. See [Models](models.md#cost-and-context-in-the-footer). | fetch once a day |
| `SSL_CERT_FILE`, `SSL_CERT_DIR` | A PEM file, or folders of PEM files, of certificate authorities to trust as well as Node.js's own, for all of Circle's HTTPS requests: the model, model lists, models.dev, `webfetch`, `websearch`, the update check and `circle update`. Set one when your network inspects HTTPS. `NODE_EXTRA_CA_CERTS` works too. A file that cannot be read is reported in one line when Circle starts. | the certificates that come with Node.js |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | The proxy for those requests, and the hosts that skip it. | no proxy |

## Agent guards

| Variable | Effect | Default |
|---|---|---|
| `CIRCLE_LOOP_GUARD` | `0`, `false`, `no` or `off` turns off the loop guard. | on |
| `CIRCLE_LOOP_DUP_THRESHOLD` | The same tool call this many times among the last few triggers a reminder. | `3` |
| `CIRCLE_LOOP_EMPTY_THRESHOLD` | This many rounds of tool calls in a row that all come back empty trigger a reminder. Calls made together in one reply count as one round. | `4` |
| `CIRCLE_LOOP_SOFT_BUDGET` | Tool calls in one turn before a soft note that says to carry on. | `25` |
| `CIRCLE_LOOP_WINDOW` | Minimum model replies between reminders, and how many recent calls are compared. | `8` |
| `CIRCLE_PRUNE_TOOL_OUTPUTS` | `0`, `false`, `no` or `off` turns off pruning of old tool output. | on |
| `CIRCLE_PRUNE_PROTECT_TOKENS` | How much recent output stays untouched by pruning. | `40000` |

While background jobs the model started are running, two calls that only wait for them (a bare `sleep`, reading a job's output again, `list_jobs`) are enough for a reminder that names the jobs; the thresholds above do not change that.

## Terminal

| Variable | Effect | Default |
|---|---|---|
| `CIRCLE_TUI_SHIMMER` | `0` turns off the rainbow animation. | on |
| `COLORFGBG` | Light or dark fallback when the terminal does not answer the colour query. | unset |
| `TMUX` | Selection copy also goes into tmux's buffer, and through tmux to the terminal. | set by tmux |
| `SSH_CONNECTION` | Selection copy uses OSC 52 only, not a local clipboard tool. | set by SSH |

## What commands see

Commands the model runs, your own `!` commands and MCP servers Circle starts get a filtered copy of the environment: any variable whose name contains a word such as `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` is removed. Circle never puts the API key it uses in the environment, so it does not reach them either. See [The shell environment](security.md#the-shell-environment).

## Installer and updates

| Variable | Read by | Effect |
|---|---|---|
| `CIRCLE_REPO` | `install.sh`, `install.ps1`, the update reminder | The GitHub repository to take releases from. Default `qingshanfeihu/circle`. `circle update` uses the one recorded at install time. |
| `CIRCLE_VERSION` | `install.sh`, `install.ps1` | Install this version instead of the newest, for example `1.0.0`. |
| `CIRCLE_PREFIX` | `install.sh`, `install.ps1` | Where versions are kept. Default `~/.local/share/circle`, or `%LOCALAPPDATA%\circle` on Windows. |
| `CIRCLE_BIN_DIR` | `install.sh`, `install.ps1` | Where the `circle` launcher goes. Default `~/.local/bin`, or `bin` under the prefix on Windows. |
| `CIRCLE_NO_PATH` | `install.sh`, `install.ps1` | `1` leaves your `PATH` and shell startup file alone. |
| `CIRCLE_ASSET_DIR` | `install.sh`, `install.ps1` | Take the archive and its `.sha256` from this folder instead of GitHub. For testing. |
| `CURL_CA_BUNDLE` | `install.sh` (through curl) | A PEM file of certificate authorities, for a network that inspects HTTPS. |
| `HTTPS_PROXY` | `install.sh` (through curl), `install.ps1` | A proxy for the download. |

The launcher sets `CIRCLE_INSTALL_PREFIX` for Circle, which is how `circle update` finds its installation. See [Installation and updates](installation.md).
