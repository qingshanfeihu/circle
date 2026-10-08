Launch a subagent with an isolated context for a complex, multi-step task.

Available subagents and their capabilities:
{available_agents}

Choose one with the required tools. The general-purpose agent has the main agent's
tools, including registered extension tools; explore is limited to read-only
search and file inspection.

Use description and subagent_type for each call. Include required context in the
description. Foreground calls wait for one report and pause for approval when needed.
With background: true, the call returns a job id and output path immediately.
The report arrives as a completion notice; do not poll or sleep. Background agents
cannot start another subagent. Processes they start are stopped when they finish.
Include the needed context, the allowed work, and the expected result in
description. The report is visible to you; summarize relevant findings for the user.

Use read_file, glob, or grep directly for a known file or a narrow search.
Independent tasks can be delegated in parallel with multiple task calls in one
message. Do not duplicate the delegated work while waiting for their results.
