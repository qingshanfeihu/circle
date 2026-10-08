# Models and request recovery

A connection specifies an API protocol (`openai` or `anthropic`), base URL, model ID and credential reference. The protocol is configured explicitly; a model name does not select another provider. Credentials live in the data folder's `credentials.json`.

Use `/models` to select an endpoint-listed model, or `/models <id>` for an exact ID. `--model` overrides the model for one invocation. `/effort` and `--thinking` select `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; endpoints can support fewer parameters than the client offers.

## Recovery

Rate limits, server errors, network failures and in-stream API errors have separate retry budgets. `Retry-After`, `retry-after-ms` and explicit retry-delay messages take precedence over exponential backoff. Quota exhaustion and unrelated client errors are returned without retries.

A rejected optional parameter is removed only when the error identifies it and it was sent. The change remains on the model instance for the session and is reported in the interface. A request may drop at most four parameters.

Once a stream has emitted content, an ordinary error does not resend that request. A keepalive-only stall may resend once. Repeating thinking may recover with a bounded reminder; repeating answer text stops the stream. Missing finish signals resend an empty response once; existing output is retained with a truncation notice. A summary with truncated output is not committed.

`CIRCLE_LLM_TIMEOUT` controls SDK request timeout in seconds (default 45, minimum 5). `CIRCLE_LLM_STALL_TIMEOUT` controls the no-progress stream deadline (default 180). `CIRCLE_LLM_REPEAT_GUARD=0` and `CIRCLE_LLM_VERIFY_FINISH=0` disable their corresponding checks. Cancellation interrupts both streaming requests and retry waits.

Tests use local HTTP endpoints and verify actual request counts, parameter bodies, partial output and cancellation. Model-profile fitting and multimodal input remain under development; the current checks do not establish every-provider compatibility.
