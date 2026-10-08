# Models and request recovery

A connection specifies an API protocol (`openai` or `anthropic`), base URL, model ID and credential reference. The protocol is configured explicitly; a model name does not select another provider. Credentials live in the data folder's `credentials.json`.

Use `/models` to select an endpoint-listed model, or `/models <id>` for an exact ID. `--model` overrides the model for one invocation. `/effort` and `--thinking` select `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; endpoints can support fewer parameters than the client offers.

## Context and model metadata

Context windows, output limits and token prices come from the packaged [models.dev](https://models.dev) snapshot and `CIRCLE_HOME/cache/models-dev.json`. The normal runtime refreshes a missing or day-old cache in the background. `CIRCLE_NO_MODELS_REFRESH=1` disables network refresh; offline startup uses the available cache or snapshot.

Entries are selected by endpoint host, then by model name for gateways. Subscription entries use a matching pay-as-you-go entry where available. Per-model account settings override the catalog:

```json
{ "models": { "my-model": { "context_window": 64000 } } }
```

`CIRCLE_MODEL_CTX=64000` applies one window to all models; a per-model setting wins. Known provider profiles supply a window when the catalog lacks that model. The final fallback is 128,000 tokens; the footer shows its window as `N/A`.

For Anthropic requests, the builder fits known effort levels, uses explicit thinking budgets for older Claude profiles, and reserves at most a quarter of the context for output. Profiles are static metadata files; the runtime executes TypeScript and protocol SDKs.

## Usage and prices

Each completed call stores its model identity, token counts, selected USD rates and amount once. Changing models or refreshing the catalog preserves earlier receipts. Summary and native subagent usage contribute to the owning conversation's totals and survive restart. Unknown prices display `N/A`; an appended `+` marks totals containing unpriced calls. USD and older RMB receipts retain separate totals.

Anthropic total input includes ordinary input, cache reads and cache writes, as described in the [Messages API](https://platform.claude.com/docs/en/api/typescript/messages). Cache reads and writes are priced separately where the catalog supplies rates. A call crossing 200,000 input tokens uses its long-context rate tier when provided.

## Compaction

Automatic compaction starts at 85% of the context window, or earlier when the output reservation consumes the remaining request budget. It retains a recent token-based tail and whole tool-call rounds. The TUI reports saving history, summarizing and completion with token counts and the history path. JSON/RPC expose `compaction` events.

`/compact [hint]` uses the same engine. Esc cancels its actual model request. A cancelled, incomplete or branch-stale summary is never committed; the saved raw history remains available.

## Recovery

Rate limits, server errors, network failures and in-stream API errors have separate retry budgets. `Retry-After`, `retry-after-ms` and explicit retry-delay messages take precedence over exponential backoff. Quota exhaustion and unrelated client errors are returned without retries.

A rejected optional parameter is removed only when the error identifies it and it was sent. The change remains on the model instance for the session and is reported in the interface. A request may drop at most four parameters.

Once a stream has emitted content, an ordinary error does not resend that request. A keepalive-only stall may resend once. Repeating thinking may recover with a bounded reminder; repeating answer text stops the stream. Missing finish signals resend an empty response once; existing output is retained with a truncation notice. A summary with truncated output is not committed.

`CIRCLE_LLM_TIMEOUT` controls SDK request timeout in seconds (default 45, minimum 5). `CIRCLE_LLM_STALL_TIMEOUT` controls the no-progress stream deadline (default 180). `CIRCLE_LLM_REPEAT_GUARD=0` and `CIRCLE_LLM_VERIFY_FINISH=0` disable their corresponding checks. Cancellation interrupts both streaming requests and retry waits.

Tests use local HTTP endpoints and verify request counts, parameter bodies, usage, retained history, partial output and cancellation. Multimodal input and additional provider/terminal cases remain under development; these checks do not establish every-provider compatibility.
