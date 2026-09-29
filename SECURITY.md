# Security policy

## Report a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. If that option is not available, open an issue that says only that you have a security report and ask for a private way to send it. Do not put details in the issue.

Include the version (`circle --version`), how you installed Circle, what you did, what happened, and what you expected. A short reproduction helps most.

Reports are handled on a best-effort basis. There is no guaranteed response time.

## Supported versions

Fixes go into the latest commit on `main` and the next release. Older releases are not patched.

## What counts

Circle runs commands and edits files on your machine because you ask it to. Some risks are part of that and are documented, not vulnerabilities: see [What is not protected](docs/security.md#what-is-not-protected) and [Known issues](docs/known-issues.md). In particular there is no operating-system sandbox, and MCP tools and custom-command shell snippets run without asking.

These are in scope:

- A way for a command or file change to run without the approval the [documentation](docs/security.md#approvals) says it needs.
- A way to run a command that Circle is meant to refuse.
- A credential or secret leaking into the conversation, a log, or a file it should not reach.
- The installer or a release file doing something other than what it says.
- Anything that lets text from a file, a web page or a tool result change Circle's approvals or settings.

If you are unsure, report it.
