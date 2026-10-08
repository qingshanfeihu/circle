Wait for at least one named background job to end, for up to `timeout_s` seconds (maximum 600). Returns ended jobs' outcomes and output tails, and identifies jobs that are still running. Cancellation stops waiting.

This tool is for subagents, which do not receive automatic completion turns. Prefer it to polling or bare sleep commands. The returned notices are consumed so the main agent does not receive them again.
