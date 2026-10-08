# Repository Guidelines

## Current Repository State

This directory is an empty project scaffold. No source code, dependencies, tests, assets, build configuration, or Git history is present. The conventions below guide initial contributions; update them when the project adopts a concrete stack.

## Project Structure & Module Organization

Keep this guide at the repository root. When adding implementation, use `src/` for application code, `tests/` for automated tests, `docs/` for supporting documentation, and `assets/` for static resources where applicable. Group modules by feature or responsibility. Add a root `README.md` explaining the project’s purpose and setup.

## Build, Test, and Development Commands

No build, test, lint, or development commands are configured yet. With the first implementation, add a dependency manifest and document exact installation, local execution, build, and test commands in `README.md`. Prefer repository-managed scripts so contributors and CI use the same commands. Do not document commands as supported until they work from a clean checkout.

## Coding Style & Naming Conventions

Follow the chosen language’s standard conventions and configure its formatter and linter early. Use consistent indentation within each file; avoid mixing tabs and spaces. Choose descriptive module, function, and variable names. Keep modules focused and avoid introducing abstractions without a concrete use case.

## Testing Guidelines

Select a testing framework appropriate to the implementation language. Add regression coverage for bug fixes and behavior-focused tests for new features. Mirror source organization under `tests/` where practical. Document the test naming convention and execution command when the framework is introduced. No coverage threshold is currently defined.

## Commit & Pull Request Guidelines

There is no Git history from which to infer existing conventions. Use concise, imperative commit subjects, such as `Add initial project configuration`, and keep commits focused. Pull requests should explain the change, link relevant issues, and report validation performed. Include screenshots for visible UI changes. Explicitly identify any checks that could not run.

## Security & Configuration

Keep credentials and local environment files out of version control. Provide sanitized example configuration and ignore generated artifacts when adding tooling.
