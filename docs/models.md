# Choose a model

Circle talks to a model endpoint that you provide. It does not include one. You need a base URL and an API key for any service or gateway that speaks the OpenAI chat completions API or the Anthropic messages API.

## Connect an endpoint

The first time you run `circle`, setup asks three questions:

1. The API base URL. For an OpenAI-style endpoint, give the path with its version, such as `https://gateway.example/v1`. For an Anthropic-style endpoint, give the gateway root.
2. The key. It shows as dots.
3. The model.

When Circle was set up before, an empty `enter` keeps the saved URL or key.

Between the key and the model, Circle asks the endpoint for its model list, with a two-and-a-half-second timeout per request. OpenAI discovery tries `<base>/models` with a bearer token, then `<base>/v1/models` if the base has no version suffix. Anthropic discovery uses `<base>/v1/models` with `x-api-key`, without doubling an existing `/v1`. A URL containing `anthropic` makes Anthropic the first protocol tried; otherwise OpenAI is first. The URL that answered is the one saved. When the endpoint lists its models, the model question is that list: type to search it, and a model it does not list can still be used, from the row `use "…"`. When it cannot be asked, Circle asks whether the API is OpenAI-style or Anthropic-style, and you type the model id your provider documents. A typed id is not checked, and no model list is ever made up.

Without the full-screen interface (`-p` or `--line` in a terminal before Circle is set up), the same questions are asked line by line, and the listed models are numbered to pick from.

The key is saved in `credentials.json` and the rest in `settings.json`. See [Settings](settings.md). `circle -m <id>` tries a model for one run without saving it.

The protocol is set by setup, never guessed from a model name: a model called `claude-…` behind an OpenAI-style gateway is sent OpenAI-style requests.

## Switch models

```text
/models                 choose from what the endpoint offers
/models qwen3.8-flash   use this id
```

`/models` (or `ctrl+l`) lists the models the endpoint offers, asking it with the saved protocol; when it cannot be asked, a red line says why. Type to search. `enter` uses the model for this session; `ctrl+s` uses it and saves it as the default for new sessions. The list marks the saved one `default`.

`/models <id>` uses the id for this session without checking that the endpoint knows it. To keep it, open `/models` and press `ctrl+s` on it.

`ctrl+p` switches to the next model for this session. It goes through the models in `enabled_models` in `settings.json`, for example `["step-3.7-flash", "step-5-*"]`, where a pattern is matched against what the endpoint lists. With no `enabled_models` it goes through every listed model. Rows in the scope are marked `in ctrl+p` in `/models`, and `tab` there adds the marked model to the scope or takes it out; the list is saved as `enabled_models` (for this run only when Circle was started with `--models`).

A model cannot be switched while a turn runs. The footer shows cost and context for the current model.

## Change the endpoint or the key

Type `/login` in a session and choose **API URL + KEY**. It asks the same questions as setup, on the list's own line, with the saved URL filled in to keep or edit and an empty `enter` keeping the saved key. The session switches to the new model at once, and the connection is saved as with setup. `esc` leaves `/login`; nothing is saved before a model is given.

Outside a session, `circle --init` runs the same setup. Both keep your other settings. See [CLI](cli.md#setting-up-again).

`/logout` clears `credentials.json` and marks the settings as not set up, so the next start, or `/login`, asks again.

## OAuth

Setup lists only the API URL and key. `/login` lists **OAuth sign-in** marked `not available yet`, and it cannot be chosen; `/login anthropic` and `/login openai` say the same. Use an API URL and key.

## Thinking depth

Circle asks models for extended thinking when the protocol supports it. The depth is one of `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.

- `/effort` lists the depths. `enter` uses one for the rest of this run; `ctrl+s` also saves it as `default_thinking` in `settings.json`.
- `/effort <level>` and `/thinking <level>` set it for the rest of this run.
- `shift+tab` switches to the next depth.
- `--thinking <level>` sets it for one run and is never saved.
- `CIRCLE_REASONING_EFFORT` sets it for a run and wins over `default_thinking`.

A change applies from the next message. When the model has a depth, the header shows it after the model name, such as `step-3.7-flash • high`.

- **Anthropic protocol**: the default is `xhigh`. For a model whose profile lists the levels it supports, Circle sends the highest one at or below your choice. For older Claude models that take a thinking budget, the budgets are 1,024 for `minimal`, 2,048 for `low`, 8,192 for `medium`, 16,000 for `high` and `xhigh`, and 31,999 for `max`, kept below the answer limit.
- **OpenAI protocol**: nothing is sent unless you choose a depth; then it is sent as `reasoning_effort`.

If an endpoint rejects a parameter Circle sent (thinking, reasoning effort, stream options and a few others), Circle drops that parameter, sends the request again, and does not send it again for the rest of the session. You see one line saying so. A request drops at most four parameters.

## When a request fails

Circle retries transient failures for you and shows the wait in the footer.

| Failure | Retries | Gives up after |
|---|---|---|
| Rate limit (429) | 5 | 10 minutes |
| Server error (408, 409, 5xx) | 6 | 5 minutes |
| Network error | 6 | 5 minutes |
| Error inside an accepted stream | 3 | 2 minutes |

The wait doubles each time up to a cap (2 minutes for rate limits, 30 seconds otherwise). If the endpoint sends `Retry-After`, `retry-after-ms` or says how long to wait in its error message, Circle uses that. Circle does not retry 402, quota or billing errors, other 4xx errors, or anything after the answer has started streaming. `esc` stops a request and a wait alike.

Three more guards protect a turn:

- A stream that sends only keep-alives for 180 seconds is cut and sent again once.
- A model that repeats itself while thinking is sent again with a reminder, twice at most. One that repeats itself in its answer is stopped.
- A response that ends with no finish signal and no output is sent again once. When it has output, the output is kept and Circle says it may be truncated.

`CIRCLE_LLM_TIMEOUT`, `CIRCLE_LLM_STALL_TIMEOUT`, `CIRCLE_LLM_REPEAT_GUARD` and `CIRCLE_LLM_VERIFY_FINISH` change these. See [Environment variables](environment-variables.md#model-requests).

## Cost and context in the footer

The footer shows tokens used, an estimated cost, the cache hit rate, and how full the context is.

The context window and the price come from [models.dev](https://models.dev), which lists each model once per provider: the same model can have a different window or price at another provider. Circle takes the entry of the provider whose API host is the host of your `base_url`. For providers models.dev lists without an address (Anthropic, OpenAI, Google, xAI, Mistral, Groq, Together, DeepInfra, Cerebras, Perplexity), their usual host counts. A host models.dev does not list (a gateway, a proxy, a server of your own), or one that does not list the model, is matched by the model's name instead (`claude-sonnet-4-5` through a gateway gets Anthropic's window and price).

A snapshot of models.dev ships with Circle. Once a day, when Circle starts, it fetches a newer copy in the background and keeps it in the data folder (`cache/models-dev.json`); without the network the copy or the snapshot is used. `CIRCLE_NO_MODELS_REFRESH=1` turns the fetch off.

**Context window.** `models` in [settings](settings.md#keys) sets it for a model, and `CIRCLE_MODEL_CTX` for every model; otherwise models.dev's figure is used; otherwise the window of a profile Circle ships for well-known models; otherwise 128,000, and the footer shows `ctx 12.5k/N/A`. The footer and the automatic [compaction](sessions.md#compaction) use this one number. On the Anthropic protocol the answer takes part of the window too: its limit (`max_tokens`) is 32,000 tokens, or a little more for older Claude models with a thinking budget, but never more than a quarter of the window or the model's own output limit; and a request must fit in 95% of the window less that limit. Compaction starts at 85% of the window, or where a request would no longer fit if that comes first: with a 200,000-token window and a 32,000-token answer limit, at 79%.

**Cost.** Pay-as-you-go prices in US dollars per million tokens: input, cached input, cache writes and output, and the long-context rates for a request over 200,000 input tokens where models.dev lists them. A cache price models.dev gives as 0 is charged as input. When the endpoint is a subscription (a coding plan or token plan, which models.dev prices at 0), the same vendor's pay-as-you-go price is shown as a reference. Each call is priced when its usage arrives and the price is stored with it, so switching models or a newer copy of models.dev does not change earlier calls. The calls a compaction or a subagent makes count in the conversation's total. It is an estimate, not a bill: a model without a price shows `N/A`, and a total that leaves out unpriced calls ends in `+`. Prices recorded in RMB by older versions are added up separately.

Endpoints report the usage of a streamed answer in different ways. Circle counts each answer once whichever way it comes. On the Anthropic protocol, input counts ordinary input, cache reads and cache writes together.
