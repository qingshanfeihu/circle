# Questions and secret input

The `question` tool takes a `questions` array. Ordinary questions accept `question`, optional `header`, string or label/description `options`, `multiple` and `custom`. The terminal shows one focus frame, supports numbered or arrow-key choices, Space for multiple selections, and a custom text answer. Esc leaves the question unanswered. Headless mode returns ordinary questions as text for the model to ask in chat.

## Secret values

For credentials, use `secret: true`, an uppercase env `key`, and a `target_file`. The interface names the key and destination before entry. Press Ctrl+S to enter a masked value. The value is delivered through private files under `secret_requests/`, written to the target env file, and excluded from chat history and tool output. Only a redacted confirmation reaches the next model request.

Values are limited to 4096 UTF-8 bytes and a single env-file line. Target writes preserve comments and unrelated keys, replace the specified key, and use an atomic private temporary file. Request and answer files are removed after collection, timeout or cancellation; late answers are rejected. Failed collection never falls back to asking for a secret in chat.

A configured SDK secret presenter may submit through `submitAnswer`. The file protocol also permits an external process to answer a pending request. Cross-process request handling uses an atomic filesystem lock and checks the request again when publishing an answer.

Tests verify private permissions where supported, timeout and cancellation cleanup, delayed answers, actual env writes, and absence of values in persisted messages, model requests and events. A controlled real PTY run validates Ctrl+S and the masked terminal flow.
