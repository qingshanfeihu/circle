# Choose a model

Circle talks to a model endpoint that you provide. It does not include one. You need a base URL and an API key for any service or gateway that speaks the OpenAI chat API or the Anthropic messages API.

## Connect an endpoint

The first time you run `circle`, setup asks for three things:

1. Choose **API URL + KEY**.
2. Enter the base URL, then the key.
3. Pick a model from the list.

Circle finds the protocol by asking the endpoint. It tries `GET <url>/models` with a bearer token first (OpenAI style), then `GET <url>/v1/models` with an `x-api-key` header (Anthropic style), two and a half seconds each. The first one that answers with a model list decides the protocol and fills the model list.

If neither answers, Circle guesses from the URL. A URL that contains `anthropic` is treated as Anthropic style. `openai`, `compatible-mode`, `openrouter`, `/v1/chat` or `azure` mean OpenAI style. Anything else is OpenAI style. In that case the model list is only the fallback `claude-sonnet-4-5`, `gpt-4.1`, `gpt-4o`, so type the id you actually want with `/models <name>` afterwards.

The key is saved in `credentials.json` and the rest in `settings.json`. See [Settings](settings.md).

## Switch models

```text
/models              list what the endpoint offers (up to 40)
/models qwen3.8-flash
```

`/models <name>` saves the name and rebuilds the model. It does not check that the endpoint knows the name. The footer shows cost and context for the current model.

To change the endpoint or the key, run `circle --init`. That also resets your other settings, so read [CLI](cli.md#setting-up-again) first.

## OAuth

The setup screen offers **OAuth login**, and `/login` exists, but no real OAuth flow is built in yet. Choosing it shows an error and returns you to the choice. Use an API URL and key.

## Thinking depth

Circle always asks models for extended thinking when they support it. Set `CIRCLE_REASONING_EFFORT` to `minimal`, `low`, `medium`, `high`, `xhigh` or `max` to change how much.

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
