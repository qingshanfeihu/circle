# Releasing

A release is a git tag `vX.Y.Z`. Pushing the tag starts the `release` workflow, which builds the runtime-inclusive package on six targets, smoke-tests each one, and publishes one GitHub Release. Users then get it from the installers and from `circle update`, and Circle tells them once a day when there is one they do not have.

Until a release exists, none of that reaches anyone. Cut one whenever `## Unreleased` in `CHANGELOG.md` holds something a user would want, and always after a fix to the installer or to `circle update`: those cannot reach a user any other way.

## Before you start

- `main` is green: the `check` and `release` workflows passed on the commit you will tag. Every push to `main` already builds and smoke-tests all six packages; it only skips publishing.
- `## Unreleased` in `CHANGELOG.md` says what changed, in the words a user would use. `npm run release` refuses an empty section.
- `docs/known-issues.md` still describes the current release.

## Cut it

```bash
npm run release -- 1.0.1     # edits package.json, package-lock.json, src/version.ts, CHANGELOG.md
git diff                     # read it
npm run check
git add package.json package-lock.json src/version.ts CHANGELOG.md
git commit -m "Release 1.0.1"
git tag v1.0.1
git push origin main v1.0.1
```

The script sets the version in the three files, renames `## Unreleased` to `## 1.0.1 - <today>` and leaves a new empty `## Unreleased` above it. It refuses when the version is not newer, when the files disagree, when one of the four files has uncommitted changes, or when there is nothing to release. The files may already name a version that has no changelog section yet; that version is accepted once. The script does not commit, tag or push.

The workflow then, on each target:

1. checks that the tag, the version files and the changelog agree (`npm run release -- --check`);
2. runs the type check, the test suite, the build and the format check;
3. builds `circle-<version>-<os>-<arch>.tar.gz` (`.zip` on Windows) with its `.sha256` (`npm run release:build`). The package holds the compiled program, its locked dependencies and a pinned Node.js;
4. runs `npm run release:smoke` against the archive, with a home and PATH of its own: the program starts from a relocated copy, answers a real tool turn against a local model endpoint, installs with `install.sh` or `install.ps1`, upgrades, keeps the data folder, rejects a bad checksum and replaces a Python circle at the default location.

When all six pass, the `publish` job checks that every archive and checksum is there, verifies the checksums again, adds `install.sh`, `install.ps1` and `SHA256SUMS`, uploads everything to a draft, compares the uploaded names and sizes, and publishes the release with the changelog section and `.github/release-install.md` as its notes.

| Runner | Asset |
|---|---|
| `ubuntu-24.04` | `circle-<version>-linux-x64.tar.gz` |
| `ubuntu-24.04-arm` | `circle-<version>-linux-arm64.tar.gz` |
| `macos-15-intel` | `circle-<version>-darwin-x64.tar.gz` |
| `macos-15` | `circle-<version>-darwin-arm64.tar.gz` |
| `windows-2025` | `circle-<version>-windows-x64.zip` |
| `windows-11-arm` | `circle-<version>-windows-arm64.zip` |

A target that fails blocks the release. Do not publish a release by hand with fewer files.

Asset names carry the version so that no asset matches what `circle update` in the Python releases (0.5.0 and older) downloads, `circle-<os>-<arch>.tar.gz`. Those users get a "has no circle-… file" error that points at the release page, whose notes tell them to run the installer.

## After

- On a clean machine: run the installer from the release notes, then `circle --version`.
- On a machine with the previous version: `circle update`, then restart Circle.
- On a machine with Circle 0.5.0: run the installer and check that the Python version is gone and the old sessions are listed.
- Fix `docs/known-issues.md` and the install text in `README.md` if they mention the old release.

## A bad release

Do not reuse a version number. People who installed it are "up to date" and will not receive a fix under the same number. Publish `X.Y.(Z+1)` with the fix. To pull the bad one, `gh release delete vX.Y.Z --cleanup-tag`; anyone who already has it can go back with `circle update <good>`.

## How the pieces fit

| Piece | Job |
|---|---|
| `scripts/release.ts` | Sets and checks the version and the changelog. `--notes` prints one version's section for the release page. |
| `scripts/build-release.ts` | Builds the package and its checksum for the current target. |
| `scripts/smoke-release.ts` | Runs the package before it is published. |
| `install.sh`, `install.ps1` | Verify the checksum, unpack, and hand the package to `install_manager`. |
| `src/install_manager.ts`, `src/install_layout.ts`, `src/legacy_install.ts` | Check and run the new version once, remove a Python circle, write `versions/<version>`, the launcher, `installation.json` and `current.ref`. |
| `src/update.ts` | `circle update` and the daily check. `circle update` runs the installer that came with the running version. |
| `tests/install-layout.test.ts`, `legacy-install.test.ts`, `update-check.test.ts`, `release-script.test.ts`, `version.test.ts` | Pin all of the above without a network. |
