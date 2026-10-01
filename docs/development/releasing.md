# Releasing

A release is a git tag `vX.Y.Z`. Pushing the tag starts the release workflow, which builds Circle on five platforms, starts a session in each build, and publishes one GitHub Release. Users then get it from the installers and from `circle update`, and Circle tells them once a day when there is one they do not have.

Until a release exists, none of that reaches anyone. Cut one whenever `## Unreleased` in `CHANGELOG.md` holds something a user would want, and always after a fix to the installer or to `circle update`: those cannot reach a user any other way.

## Before you start

- `main` is green: the `check` workflow passed on the commit you will tag.
- `## Unreleased` in `CHANGELOG.md` says what changed, in the words a user would use. `scripts/release.py` refuses an empty section.
- `docs/known-issues.md` still describes the current release. Entries about "the only release" and the platform list need a new date or removal once you publish.

## Rehearse

The first time, and after any change to `.github/workflows/release.yml`, `packaging/circle.spec` or `install.*`:

1. Open **Actions → release → Run workflow** on the branch.
2. Wait for the five build jobs. Windows may fail on the first runs; read its log and fix what it shows. Each runs the tests, freezes the program, runs `scripts/smoke_frozen.py` on it, and packs the asset. Nothing is published on a manual run.
3. Download an artifact and try it if a platform is new.

## Cut it

```bash
python scripts/release.py 0.2.0        # edits pyproject.toml, circle/__init__.py, CHANGELOG.md
git diff                               # read it
python -m pytest -q
git add pyproject.toml circle/__init__.py CHANGELOG.md
git commit -m "Release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

The script sets the version in both files, renames `## Unreleased` to `## 0.2.0 - <today>` and leaves a new empty `## Unreleased` above it. It refuses when the version is not newer, when the two files disagree, when one of the three files has uncommitted changes, or when there is nothing to release. It does not commit, tag or push.

The workflow then:

1. checks that the tag, both version files and the changelog agree (`scripts/release.py --check`);
2. runs the test suite on every platform;
3. freezes the program with `packaging/circle.spec`;
4. starts it and opens a session (`scripts/smoke_frozen.py`): the version matches, the prompt files are inside, `/help` and `/exit` work;
5. packs `circle-<os>-<arch>.tar.gz` (`.zip` on Windows) and its `.sha256` (`scripts/pack_release.py`);
6. once all five pass, publishes the release with the assets, `install.sh`, `install.ps1`, `SHA256SUMS`, and the changelog section as the notes.

| Runner | Asset |
|---|---|
| `ubuntu-22.04` | `circle-linux-x86_64.tar.gz` |
| `ubuntu-22.04-arm` | `circle-linux-arm64.tar.gz` |
| `macos-15-intel` | `circle-darwin-x86_64.tar.gz` |
| `macos-15` | `circle-darwin-arm64.tar.gz` |
| `windows-2025` | `circle-windows-x86_64.zip` |

A platform that fails blocks the release. Every archive and its checksum must be present before publication; the publish job verifies the checksums again. Do not publish a release by hand with fewer files.

## After

- On a clean machine: run the installer from the release notes, then `circle --version`.
- On a machine with the previous version: `circle update`, then restart Circle.
- Fix `docs/known-issues.md` and the install text in `README.md` if they mention the old release.

## A bad release

Do not reuse a version number. People who installed it are "up to date" and will not receive a fix under the same number. Publish `X.Y.(Z+1)` with the fix. To pull the bad one, `gh release delete vX.Y.Z --cleanup-tag`; anyone who already has it can go back with `circle update --version <good>`.

## How the pieces fit

| Piece | Job |
|---|---|
| `scripts/release.py` | Bumps and checks the version and the changelog. `--notes` prints one version's section for the release page. |
| `scripts/pack_release.py` | Turns `dist/circle` into the asset and its checksum. |
| `scripts/smoke_frozen.py` | Runs the frozen program before it is packed. |
| `install.sh`, `install.ps1` | First install. Verify the checksum, unpack to `versions/<version>`, point `current` at it. |
| `circle/update.py` | `circle update` and the daily check. Same layout and asset names as the installers. |
| `tests/test_install_sh.py`, `test_install_ps1.py`, `test_update.py`, `test_release_script.py` | Pin all of the above without a network. |
