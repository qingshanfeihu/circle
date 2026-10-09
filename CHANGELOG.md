# Changelog

All notable changes to Circle are listed here, newest first. Circle follows [Semantic Versioning](https://semver.org) from 1.0 on.

## Unreleased

Circle 1.0 is a rewrite in TypeScript. It works as 0.5.0 did: the same screen, keys, commands, settings and data folder. What changes is underneath and in how it is installed.

### Changed

- **Circle runs on Node.js instead of Python.** The agent loop is Circle's own; LangChain, LangGraph and deepagents are gone. A release package carries its own Node.js, so nothing has to be installed first.
- **Upgrading from 0.5.0 or older takes the one-command installer once.** It removes the Python version, whether the old installer or pip put it there, installs 1.0 in the same place, and keeps the data folder. If a Python circle is still running it stops without changing anything. The old `circle update` cannot make this step: it reports that the release has no file for your platform. See [Installation and updates](docs/installation.md#replacing-the-python-circle).
- **Saved sessions move to `circle.sqlite`.** On the first start Circle imports the conversations in `sessions.sqlite` and `checkpoints.sqlite` without changing those files, and keeps a copy of what it read in `migration-backups/`.
- **Extensions are JavaScript or TypeScript** (`extension.mjs`, `extension.js` or `extension.ts`); `extension.py` no longer loads. The API is the same in camelCase. See [Extensions](docs/extensions.md).
- **Release files carry the version in their name**, `circle-<version>-<os>-<arch>.tar.gz` (`.zip` on Windows), and there are builds for Windows on ARM64.

### Added

- **`CIRCLE_CONTEXT_WINDOW`** sets the context window when neither models.dev nor `models` in `settings.json` knows the model.
- **`@file` can name an image or a PDF**: it reaches the model as an attachment, as `read_file` results already did.

## 0.5.0 - 2026-10-08

### Added

- **Background jobs.** A command or a subagent can keep running while you and the model go on. The model starts one with `background: true` on `execute` or `task`; a command still running at the default timeout goes on as a job instead of being ended; `ctrl+b` moves the command being waited on (yours too) to the background; and processes a command leaves running (`server &`) become a job. Each job's output is kept in a file the model reads, rows below the input box show what runs, and `/jobs` opens or stops them. When a job ends the model gets a notice, and Circle starts a turn for it when nothing else runs, so the model no longer polls or sleeps. Leaving Circle, closing the terminal or a `SIGTERM` stops every job. See [Background jobs](docs/background-jobs.md).
- **Background subagents ask in their own cards.** Their approvals and questions appear whether a turn runs or not, named after their job, after the running turn's own cards.
- **The model has `list_jobs` and `stop_job`**, and the `general-purpose` subagent `wait_jobs`.
- **Extensions can wait for something slow** by returning `api.Watch` from a tool: Circle polls it off the model's turns and hands the result over as a notice. See [Build extensions](docs/extensions.md#waiting-for-something-slow).
- **Print mode waits for the model's background jobs** after its answer, up to `CIRCLE_JOB_WAIT` seconds; JSON and RPC modes report jobs as events, and RPC mode has `list_jobs` and `stop_job`.
- **Compaction shows itself while it runs.** A row above the input box follows the automatic compaction and `/compact` step by step with a progress bar, and one line stays when it is done: how many tokens before and after, how many messages were summarized and kept, and where the older messages were saved. A failed compaction leaves a red line. See [Compaction](docs/sessions.md#compaction).
- **`models` in `settings.json` sets a model's context window**, and `CIRCLE_MODEL_CTX` sets every model's.

### Changed

- **Context windows and prices come from [models.dev](https://models.dev).** A snapshot ships with Circle and a newer copy is fetched once a day in the background (`CIRCLE_NO_MODELS_REFRESH` turns that off). Circle takes the entry of the provider your `base_url` points at, and for a gateway or a proxy the model's own vendor's. The footer's cost is in US dollars at pay-as-you-go prices, a subscription's being its vendor's for reference; a window or a price Circle does not know reads `N/A`. The footer and the automatic compaction use the same window. See [Models](docs/models.md#cost-and-context-in-the-footer).
- **A command's standard output and standard error come back together**, in the order they were written, instead of standard error after standard output with a `[stderr]` prefix.
- **A command that runs past the default timeout is no longer ended**: it goes on as a background job. One the model gave its own `timeout` is still ended then.
- **The Gemini prompt no longer tells the model to start servers with `&`.**
- **On Windows, `esc` ends a running command** with everything it started (`taskkill /T`), and `ctrl+b` and the default timeout move it to the background, as elsewhere. This has not been tried on a real Windows machine yet.

## 0.4.0 - 2026-10-08

### Added

- **A welcome block opens every session.** At the top of the conversation: Circle's logo, the version, the model and its endpoint, the folder and its git branch, what the folder brings (its instruction files, skills, commands, extensions and settings) with a lamp each, and the folder's three most recent sessions. It is not saved or exported. Once it scrolls away, the header shows the version, model and folder again. See [The welcome](docs/interface.md#the-welcome).

### Changed

- **Setup and trust are asked on the session's own screen.** Each question is a card in the input box under the welcome, and the session starts in place after the last answer, instead of on a separate screen first. The trust card says what trusting loads from the folder, and warns when the folder has extensions, which run their own code.
- **The screen comes up before Circle has loaded.** While extensions, commands and MCP servers load, the folder's rows in the welcome blink. What you send meanwhile waits and is sent once Circle is ready.
- **Setup's model list is searched by typing**, like the other lists. A model the endpoint does not list can be typed and chosen as `use "<id>"`. In the full-screen setup, numbers no longer pick a model.
- **OAuth sign-in cannot be chosen in setup** while it is not built, as in `/login`.

### Fixed

- **Setup froze while it asked the endpoint for its models.** It now asks in the background and says so on the card.

## 0.3.1 - 2026-10-08

### Changed

- **`/login` asks how to sign in.** Without a word it lists the ways in. **API URL + KEY** asks for the base URL, the key (shown as dots; pasting works) and the model, as setup does, and switches the session to them without a restart; nothing is saved before a model is picked. OAuth is listed as `not available yet`. The endpoint row of `/settings` opens it. See [Change the endpoint or the key](docs/models.md#change-the-endpoint-or-the-key).
- **A turn the endpoint refuses because of the key** (HTTP 401 or 403, such as a wrong key or an account without a plan) ends in `· /login to change the key`.
- **Secondary text reads on every surface it is drawn on.** Dim and faint text keep their contrast on the lists' panel and inside tool, thinking and subagent blocks, not only on the background. On a light terminal they are a little darker; on a dark one faint text is a little brighter.

### Fixed

- **Open lists kept their old colours** when the terminal switched between dark and light under the `auto` theme. They are drawn again at once.
- **Pasting while a list was open put the text in the input box behind it.** It goes into the list's search, or into the line the list asks for.
- `circle --help` said `--init` resets `settings.json`. It replaces the endpoint, key and model and keeps the rest.
- **A secret entered just as its request timed out could still be taken** when the disk was slow, as on some Windows machines. It is now shredded with the request, as a late answer always was.

## 0.3.0 - 2026-10-06

### Added

- **Print, JSON and RPC modes.** `circle -p "prompt"` runs a turn and prints the answer, with piped input put before the prompt. `--mode json` writes every step as one JSON object per line, and `--mode rpc` runs Circle as a child process driven by JSON commands, following pi's RPC mode. Calls that would ask for approval are not run unless you pass `--yolo`. See [Print mode](docs/cli.md#print-mode).
- **Sessions that reopen.** `circle -c` goes on with the most recent conversation in the folder; `circle -r` and `/resume` pick one from a list, where you can also rename, delete and see every folder's sessions. `--session`, `--session-id`, `--fork`, `--no-session` and `--name` choose or start one. Leaving prints the command that reopens the session, and a reopened session is drawn again from its saved messages. See [Sessions](docs/sessions.md).
- **Going back and branching.** `/tree`, or `esc` twice on an empty input box, lists every message of the session and all its branches, with labels. Choosing one goes back there, and your next message starts a branch while the old one stays. `/fork` starts a new session from one of your messages and `/clone` copies the session. `/export` writes Markdown, HTML or JSONL; `/import` reads a JSONL export back.
- **Steering.** A message sent while a turn runs is read by the model after its current step. `ctrl+q` queues a follow-up for after the turn instead, and `alt+↑` takes waiting messages back. Waiting messages are listed above the input box.
- **Models and thinking depth.** `/models` (`ctrl+l`) lists what the endpoint offers: `enter` uses a model for the session, `ctrl+s` also saves it, and `tab` adds it to the models `ctrl+p` switches between (`enabled_models`). `/effort`, `shift+tab`, `--thinking` and `default_thinking` set the thinking depth.
- **Command-line options from pi:** messages and `@file`s after the folder, `-m`, `--thinking`, `--models`, `--list-models`, `--export`, `--system-prompt` and `--append-system-prompt` (and the `SYSTEM.md` and `APPEND_SYSTEM.md` files), `--no-context-files`, `--tools`, `--exclude-tools` and `--no-tools`.
- **Input.** A completion list for `/commands` and `@files` as you type. An input box that grows to several rows. `!command` runs a shell command yourself. `ctrl+f` finds text in the conversation, `ctrl+x` copies the last answer, `ctrl+g` edits the draft in your editor and `ctrl+z` suspends Circle. Your own keys go in `keybindings.json`.
- **`/settings`** lists the settings and changes the marked one with `enter`. `/session` shows the session's id, folder, model, counts and tokens. A project can set a few things in `.circle/settings.json`. Custom commands accept pi's prompt templates (`$1`, `$@`, `${2:-default}`, `${@:2}` …) and are read from pi's folders too.
- **Approval for a kind of command.** For a command that is one program with its arguments, the approval card also offers `Allow "python3 -m pytest …" for this session`, which covers every command that starts with those words. See [Security](docs/security.md#approvals).
- **The approval card shows the diff of a file change**: the lines added and removed, against the file as it is now.
- The header shows the git branch and the thinking depth, the terminal title names the folder and the session, and the context meter turns yellow and then red as the context fills.

### Changed

- **Setup, the trust screen and the installer are in English**, like the rest of the interface.
- **`circle --init` keeps your settings.** It replaces only the endpoint, key and model, and `enter` on an empty line keeps the saved URL and then the saved key. Saving settings also keeps keys Circle does not know.
- **Circle writes nothing into your project.** Trusting a folder no longer creates `.agent/`. The messages a summary replaced, and very long tool results, are kept in the data folder under `projects/` instead of `conversation_history/` and `large_tool_results/` in the workspace.
- **A `cd` into the workspace in front of a command** (`cd /your/project && make test`) no longer stops a "for this session" rule from matching, and the system prompt asks the model not to add it. The system prompt also asks the model to run the project's test runner and not to say tests pass without its output.
- **Commands the model runs no longer use Circle's own virtual environment** when you started Circle from a shell where it was active, so `python3` and `pip` are your project's.
- **`install.sh` starts the new version once before switching to it.** A build that does not start leaves the previous install in place, and the slow first start of a newly downloaded program happens during the install instead of on your first `circle`. `install.ps1` and `circle update` do not do this yet.
- `/tree` and `/fork` show messages without Markdown marks, and in every list a long row is cut so that the column on the right stays visible.

### Fixed

- **Setup could not list models in the prebuilt program on macOS.** Certificate checks failed, so setup showed `connection failed`, did not find the `/v1` path, and the first message got a 404. Model discovery, web fetch and web search now fall back to the CA certificates bundled with Circle, as `circle update` already did, and a certificate failure is named as one.
- **The API key was shown in clear text** while you typed it during setup. It is shown as dots.
- **Endpoints that repeat the running usage total on every streamed chunk** (StepFun and other OpenAI-compatible gateways) were counted once per chunk. The footer showed millions of tokens and a summary started on almost every step. Each answer is now counted once.
- **A summary made during a turn could appear as the answer**, with its words run together, when the model's own reply was empty. The answer is now only the model's last message, and a summary's text never reaches the screen.
- `esc` now stops a running shell command at once, with everything it started. Not on Windows yet.
- `esc` on a setup screen leaves setup, as `ctrl+c` does. A lone `esc` used to be held, waiting for the rest of an escape sequence.
- A long paste reaches the model as the pasted text, not as its placeholder.
- `/fork` and `/clone` give the model the earlier messages, `/tree` goes back for the model as well as on screen, and sessions are listed again after a restart.
- `$10` and beyond work in custom commands, and `/editor` works when `$EDITOR` has arguments.
- On a case-insensitive file system, `AGENTS.md` is put in the prompt once.
- The `grep` tool's description says it searches for literal text.
- `/mcp` and `/extensions` print English.
- `circle --help` describes Circle, tool output such as `ls` is shown as a list instead of raw JSON, and the token meters are hidden on the setup screens.

## 0.2.1 - 2026-10-01

### Fixed

- The first command after initialization or workspace trust now reaches the main interface. The previous screen finishes its input reader before the session takes over the terminal.
- Ctrl+C cancels initialization, and cancellation restores the terminal and stops its input reader.

## 0.2.0 - 2026-10-01

### Added

- **`circle update`.** Installs the newest release: it downloads the file for your system, checks its sha256, unpacks it beside the running version and moves the `current` link. `--check` only reports, `--version X.Y.Z` installs a given release or goes back. See [Updating](docs/cli.md#updating).
- **Update reminder.** Once a day, when the full-screen interface starts, Circle checks GitHub for a newer release and says so in one line. Turn it off with `update_check` in settings or `CIRCLE_NO_UPDATE_CHECK=1`.
- **Windows.** The interface runs in the Windows console (Windows 10 1809 or newer), with an `install.ps1` installer and a Windows build in the release workflow. Interactive console behaviour still needs real-machine testing; see [Known issues](docs/known-issues.md#install-and-release). The approval rules understand `del`, `Remove-Item`, `cmd /c`, `powershell -Command` and `C:\path\.env`, and the system prompt tells the model its commands run in `cmd.exe`.
- **Releases for macOS (Apple silicon and Intel), Linux (x86_64 and arm64) and Windows (x86_64)**, built by a workflow that runs the tests, freezes the program, starts a session in it, and publishes only if every platform passed. `python scripts/release.py X.Y.Z` prepares a release. See [Releasing](docs/development/releasing.md).
- **Interface contract.** One set of rules decides where each piece of information appears: conversation, persistent lines, plan box, the input box that turns into a card, popup, page, or a one-second flash. Lamps show state, tints show the kind of work, and the frame shows whose turn it is. See [The interface](docs/interface.md).
- **Dark and light terminals.** Secondary text and the rainbow frame keep a readable contrast on any background. The `auto` theme follows the terminal while Circle runs, so a switch between a dark and a light theme is picked up without a restart. `/themes auto|dark|light` chooses. See [Dark and light terminals](docs/interface.md#dark-and-light-terminals).
- **Skills.** Agent Skills discovery, the `skill` tool and `/skill`.
- **MCP servers**, plan-mode write gates, more tools and a session tree.
- **Extensions.** Python modules that register tools, commands, middleware, subagents, result renderers and event handlers.
- **Approvals.** Commands are sorted into allow, ask and refuse. "Always allow" is remembered per session and managed with `/approvals`.
- **Auto mode.** `/yolo` (`/auto`) stops asking for the current session.
- **Model guard.** Retries with backoff and `Retry-After`, dropping a parameter the endpoint rejects, detection of stalled or repeating streams, and thinking depth chosen by model family.
- **Reliability middleware.** Tool errors return to the model instead of ending the turn, wrong-case tool names and argument shapes are repaired, loops are interrupted, and old tool output is shortened in requests.
- **Secrets.** The model can ask for a secret with `question`. You enter it masked with `ctrl+s`, and it is written to a file without entering the conversation.
- **Plan box, subagent strip and record, live footer meters, file diffs**, and rendering of GFM tables and task lists.
- `websearch`, and `~` expansion in file paths.
- New documentation in `docs/`, `CONTRIBUTING.md`, `AGENTS.md` and `SECURITY.md`.

### Changed

- **The installer** decides the operating system before it touches the network, finds the newest release without the GitHub API (so no rate limit), checks the sha256 of what it downloaded, and explains a certificate failure, a missing file for your platform and an unreachable network instead of printing curl's error. In a Windows shell (Git Bash, MobaXterm, Cygwin) it installs the Windows program through PowerShell. It keeps the newest versions in `versions/<version>` with a `current` link, so installing or updating never removes the copy that is running (a version that is already installed is left alone). The one exception is moving a `v0.1.0` install to this layout, which has to replace its `current` folder: run the installer once with Circle closed.
- Commands the model runs now inherit your environment with secret-looking variables removed, instead of an empty one.
- Models outside the built-in catalogue get a full output budget, and a reply that used the whole budget for thinking says so.
- Cancelling a turn is checked at every model and tool boundary, and a cancelled turn drains its queue in order.

### Fixed

- Model discovery uses only valid IDs returned by the server, reports empty or failed responses, and supports explicit manual configuration. API paths no longer omit or duplicate `/v1`, and the original host is preserved.
- Timer snapshots and UI actions share a lock, preventing a cancelled turn from deadlocking the next queued message.
- Checkpoints finish writing between agent steps, preventing stalled multi-step turns.
- Windows redirected output remains Unicode-safe in the prebuilt program.
- Windows host drive paths and expanded home paths work with filesystem tools while traversal checks remain enforced. Non-console output uses default terminal dimensions.
- Frozen builds include both provider integrations and package metadata. Native archives are installed and started offline before publication; all five archives must match the release commit and pass checksum verification.

- The release workflow could not succeed: it ran `pytest` without installing it, so no release was ever built by CI and the only release was uploaded by hand. It now installs the test extras and runs on a tag, and can be run by hand to rehearse a release.
- The prebuilt program did not include the prompt files the agent reads at start. The PyInstaller recipe now bundles them, and every module under `circle/`.
- `install.sh` ended with `tmp: unbound variable`: its cleanup ran after the function that owned the variable had returned.
- `/yolo` no longer drops an approval that arrives on the worker thread, and applies only to turns you can see.
- Approval policy is frozen for the length of a paused turn.
- Rebuilds of the MCP connection are refused while a turn is running.
- A stale context meter is cleared after a new session or a compaction.
- Reasoning text keeps its code fences when it is truncated, and expanded reasoning is cached per width and palette.
- Markdown emphasis boundaries and table delimiters render correctly.

## 0.1.0 - 2026-09-22

First release. A prebuilt binary for macOS on Apple silicon, an installer, a full-screen session built on a renderer modelled on Ink, and slash commands aligned with Pi and OpenCode.
