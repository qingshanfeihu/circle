Launch a synchronous, ephemeral subagent for a complex, multi-step task.

Available subagents and their capabilities:
{available_agents}

Choose one with the required tools. The general-purpose agent has the main agent's
tools, including registered extension tools; explore is limited to read-only
search and file inspection.

Use description and subagent_type for each call. Isolated agents start with a
fresh context; a listed agent that inherits the conversation is marked as such.
Calls run synchronously, pausing if approval is needed, and return one report.
Include the needed context, the allowed work, and the expected result in
description. The report is visible to you; summarize relevant findings for the user.

Use read_file, glob, or grep directly for a known file or a narrow search.
Independent tasks can be delegated in parallel with multiple task calls in one
message. Do not duplicate the delegated work while waiting for their results.
