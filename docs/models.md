# Choose a model

Circle talks to a model endpoint that you provide. It does not include one. You need a base URL and an API key for any service or gateway that speaks the OpenAI chat API or the Anthropic messages API.

## Connect an endpoint

The first time you run `circle`, setup asks for three things:

1. Choose **API URL + KEY**.
2. Enter the base URL, then the key.
3. Pick a model from the list.

Circle asks the endpoint for its model list, with a two-and-a-half-second timeout per request. OpenAI discovery tries `<base>/models` with a bearer token, then `<base>/v1/models` if the supplied base has no version suffix. Anthropic discovery uses `<base>/v1/models` with `x-api-key`, without duplicating an existing `/v1`. A URL containing `anthropic` makes Anthropic the first protocol tried; otherwise OpenAI is first. The host and gateway prefix stay unchanged. Setup saves the working base URL for subsequent model requests.

Only valid server-provided model IDs appear in the list. Empty responses, failed requests and malformed responses never produce a built-in model list. Setup shows the outcome; if discovery fails, choose the protocol explicitly. You can enter a model ID manually whether or not discovery succeeds. A manually entered ID is not verified. If discovery failed, use the provider's documented API base URL: Circle cannot determine an unresponsive endpoint's path.

For scripted setup, `complete_api_key_init` requires both `protocol` and `model` when discovery fails, or an explicit `model` when the endpoint returns an empty list. It raises an error before saving settings when these values are missing. `circle -m <name>` tries a model for one run without saving it.

The key is saved in `credentials.json` and the rest in `settings.json`. See [Settings](settings.md).

## Switch models

```text
/models                 choose from what the endpoint offers
/models qwen3.8-flash   use this id
```

`/models` (or `ctrl+l`) lists the models the endpoint offers, asking it with the saved protocol; when it cannot be asked, a red line says why and no names are made up. Type to search. `enter` uses the model for this session; `ctrl+s` uses it and saves it as the default for new sessions. The list marks the saved one `default`.

`/models <name>` uses the id for this session without checking that the endpoint knows it. To keep it, open `/models` and press `ctrl+s` on it.

`ctrl+p` switches to the next model for this session. It goes through the models in `enabled_models` in `settings.json`, for example `["step-3.7-flash", "step-5-*"]`, where a pattern is matched against what the endpoint lists. With no `enabled_models` it goes through every listed model. Rows in the scope are marked `in ctrl+p` in `/models`, and `tab` there adds the marked model to the scope or takes it out; the list is saved as `enabled_models` (for this run only when Circle was started with `--models`).

The footer shows cost and context for the current model.

## Change the endpoint or the key

Type `/login` in a session and choose **API URL + KEY**. It asks the same questions as setup: the base URL (the saved one is filled in to keep or edit), the key (shown as dots; a paste works), then the model from what the endpoint lists. When the endpoint cannot be asked, it asks whether the API is OpenAI-style or Anthropic-style and takes a model id you type. The session switches to the new model at once, and the connection is saved as with setup. `enter` on an empty line keeps the saved URL or key. `esc` on the URL or key line goes back to the list, and `esc` on a list leaves `/login`; nothing is saved before a model is picked.

When the endpoint turns the key down (HTTP 401 or 403, for example a wrong key or an account with no plan), the red line under the turn ends in `· /login to change the key`.

Outside a session, `circle --init` runs the same setup. Both keep your other settings. See [CLI](cli.md#setting-up-again).

## OAuth

The setup screen and `/login` list **OAuth sign-in**, but no real OAuth flow is built in yet. In setup, choosing it shows an error and returns you to the choice; in `/login` it is marked `not available yet` and choosing it does nothing. Use an API URL and key.

## Thinking depth

Circle always asks models for extended thinking when they support it. The depth is one of `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.

- `/effort` lists the depths. `enter` uses one for the rest of this run; `ctrl+s` also saves it as `default_thinking` in `settings.json`.
- `/effort <level>` and `/thinking <level>` set it for the rest of this run.
- `shift+tab` switches to the next depth.
- `CIRCLE_REASONING_EFFORT` sets it for a run and wins over `default_thinking`.

A change applies from the next message. When the model has a depth, the header shows it after the model name, such as `step-3.7-flash • high`.

- **Anthropic protocol**: the default is `xhigh`. Circle picks the highest level the model supports at or below your choice. For Claude models that use a thinking budget, the budgets are 1,024 for `minimal`, 2,048 for `low`, 8,192 for `medium`, 16,000 for `high` and `xhigh`, and 31,999 for `max`.
- **OpenAI protocol**: nothing is sent unless you set the variable, and only for models that accept it.

If an endpoint rejects a parameter Circle sent (thinking, reasoning effort, stream options and a few others), Circle drops that parameter, resends, and does not send it again for the rest of the session. You see one line saying so.

## When a request fails

Circle retries transient failures for you and shows the wait in the footer.

| Failure | Retries | Gives up after |
|---|---|---|
| Rate limit (429) | 5 | 10 minutes |
| Server error (408, 409, 5xx) | 6 | 5 minutes |
| Network error | 6 | 5 minutes |
| Error inside an accepted stream | 3 | 2 minutes |

The wait doubles each time up to a cap (2 minutes for rate limits, 30 seconds otherwise). If the endpoint sends `Retry-After`, Circle uses it. Circle does not retry 402, quota or billing errors, other 4xx errors, or anything after the answer has started streaming.

Three more guards protect a turn:

- A stream that sends only keep-alives for 180 seconds is cut and sent again once.
- A model that repeats itself before answering is sent again with a reminder, twice at most.
- A response that ends with no finish reason and no text is sent again once.

`CIRCLE_LLM_STALL_TIMEOUT`, `CIRCLE_LLM_REPEAT_GUARD` and `CIRCLE_LLM_VERIFY_FINISH` change these. See [Environment variables](environment-variables.md).

## Cost and context in the footer

The footer shows tokens used, an estimated cost, the cache hit rate, and how full the context is.

Endpoints report the usage of a streamed answer in different ways: once at the end, split between the first and last chunk, or (some OpenAI-compatible gateways) as the running total on every chunk. Circle counts each answer once whichever way it comes, so the footer, the cost and the point at which a long conversation is compacted are the same for all of them.

Cost uses a built-in list of reference prices per million tokens. It is an estimate, not a bill. Models that are not in the list show `—`.

| Model | Currency | Input | Cached input | Output |
|---|---|---|---|---|
| `qwen3.8-flash` | ¥ | 0.8 | 0.1 | 2.7 |
| `qwen3.8-max` | ¥ | 12.0 | 1.5 | 36.0 |
| `mimo-v2.5` | ¥ | 1.0 | 0.02 | 2.0 |
| `mimo-v2.5-pro` | ¥ | 3.0 | 0.025 | 6.0 |
| `claude-sonnet-5`, `claude-sonnet-4-5`, `claude-sonnet-4` | $ | 3.0 | 0.30 | 15.0 |
| `deepseek-flash`, `deepseek-v4-flash` | $ | 0.30 | 0.006 | 1.20 |
| `deepseek-v4-pro` | $ | 1.32 | 0.044 | 3.96 |

The context window comes from the model name: 200,000 for the Claude models above and other names containing `sonnet`, `opus` or `haiku`; 1,000,000 for `qwen3.8-flash`; 262,144 for `qwen3.8-max`; 128,000 for anything else. Set `CIRCLE_MODEL_CTX` if your model is different.
