Wait until at least one of the given background jobs ends, and return how it ended with the end of its output.

Use it instead of `sleep` when your task needs a job's result before you can report. It returns early when the user presses esc, and after `timeout_s` seconds at most.
