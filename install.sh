#!/usr/bin/env bash
# Circle installer: fetches the PyInstaller onedir build from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
#
# Downloads the build for this machine, checks its sha256, unpacks it to
# ~/.local/share/circle/versions/<version>, points `current` at it and ~/.local/bin/circle at
# `current`. `circle update` uses the same layout. No Python is needed on the machine; for
# development, CIRCLE_FROM_SOURCE=1 does an editable install from this checkout instead.
#
# In a Windows shell (Git Bash, MobaXterm, Cygwin, MSYS) it hands over to PowerShell, which runs
# install.ps1 and installs the native Windows build.
#
# Environment variables:
#   CIRCLE_REPO        default qingshanfeihu/circle
#   CIRCLE_VERSION     pin a version (1.0.0 or v1.0.0); default is the newest release
#   CIRCLE_BIN_DIR     default ~/.local/bin
#   CIRCLE_PREFIX      install root, default ~/.local/share/circle
#   CIRCLE_HOME        Circle's data folder, default ~/.circle (the installer only creates it)
#   CIRCLE_FROM_SOURCE set to 1 for `pip install -e` of this checkout (development)
#   CURL_CA_BUNDLE     a CA bundle (PEM) for curl; point it at your proxy's root certificate
#                      when your network inspects HTTPS

set -euo pipefail

CIRCLE_REPO="${CIRCLE_REPO:-qingshanfeihu/circle}"
BIN_DIR="${CIRCLE_BIN_DIR:-$HOME/.local/bin}"
PREFIX="${CIRCLE_PREFIX:-$HOME/.local/share/circle}"
HOME_DIR="${CIRCLE_HOME:-$HOME/.circle}"
TMP_DIR=""

log()  { printf '[circle-install] %s\n' "$*" >&2; }
warn() { printf '[circle-install] warning: %s\n' "$*" >&2; }
die()  { printf '[circle-install] error: %s\n' "$*" >&2; exit 1; }

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

# Say why curl failed and what to do; the caller already has the failure status.
explain_curl_failure() {
    local rc="$1" url="$2"
    case "$rc" in
        35|51|58|60|77|82|83)
            warn "the TLS certificate could not be verified (curl exit code $rc): $url"
            warn "usually a company proxy or gateway replaces HTTPS certificates and the system does not have its root certificate."
            warn "export that root certificate to a PEM file and run the install again with CURL_CA_BUNDLE=/path/to/ca.pem"
            warn "do not skip the check with curl -k: what is downloaded is a program you will run."
            ;;
        22)
            warn "the server returned an error (HTTP 4xx/5xx): $url"
            warn "the release may have no file for this system. See https://github.com/${CIRCLE_REPO}/releases"
            ;;
        6|7|28|56)
            warn "cannot reach $url (curl exit code $rc). Behind a proxy, set HTTPS_PROXY."
            ;;
        *)
            warn "download failed (curl exit code $rc): $url"
            ;;
    esac
}

# fetch URL DEST: on failure, say why and exit
fetch() {
    local url="$1" dest="$2" rc=0
    curl -fsSL "$url" -o "$dest" || rc=$?
    if [[ $rc -ne 0 ]]; then
        explain_curl_failure "$rc" "$url"
        die "download failed"
    fi
}

detect_os() {
    case "$(uname -s)" in
        Darwin) printf 'darwin' ;;
        Linux)  printf 'linux' ;;
        MINGW*|MSYS*|CYGWIN*) printf 'windows' ;;
        *) die "unsupported system: $(uname -s)" ;;
    esac
}

detect_asset() {
    local os_tag arch arch_tag
    os_tag="$(detect_os)"
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) arch_tag="x86_64" ;;
        arm64|aarch64) arch_tag="arm64" ;;
        *) die "unsupported processor architecture: $arch" ;;
    esac
    # asset: circle-linux-x86_64.tar.gz
    printf 'circle-%s-%s.tar.gz' "$os_tag" "$arch_tag"
}

validate_version() {
    [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+.]?[0-9A-Za-z][0-9A-Za-z.+-]*)?$ ]] \
        || die "invalid version: $1 (expected a version like 0.2.0)"
}

# The newest release's version: follow the /releases/latest redirect rather than ask the API,
# which limits anonymous requests.
resolve_version() {
    if [[ -n "${CIRCLE_VERSION:-}" ]]; then
        validate_version "${CIRCLE_VERSION#v}"
        printf '%s' "${CIRCLE_VERSION#v}"
        return
    fi
    need_cmd curl
    local url final rc=0
    url="https://github.com/${CIRCLE_REPO}/releases/latest"
    final="$(curl -fsSIL -o /dev/null -w '%{url_effective}' "$url")" || rc=$?
    if [[ $rc -ne 0 ]]; then
        explain_curl_failure "$rc" "$url"
        die "cannot find the newest release of ${CIRCLE_REPO}"
    fi
    [[ "$final" == */releases/tag/* ]] || die "${CIRCLE_REPO} has not published a release yet"
    final="${final##*/}"
    printf '%s' "${final#v}"
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        die "neither sha256sum nor shasum is installed, so the download cannot be checked"
    fi
}

install_from_source() {
    need_cmd python3
    local root
    root="$(cd "$(dirname "$0")" && pwd)"
    log "development install: pip install -e $root"
    python3 -m pip install -U pip setuptools wheel
    python3 -m pip install -e "$root"
    mkdir -p "$BIN_DIR" "$HOME_DIR"
    if ! command -v circle >/dev/null 2>&1; then
        warn "circle is not on your PATH; add pip's scripts folder to it"
    fi
    log "data folder: $HOME_DIR (the first run of circle writes settings.json)"
    log "start with: circle"
}

# Run in a Windows shell: install the native Windows build through PowerShell, which uses the
# Windows certificate store, where a company root certificate usually already is.
install_windows() {
    command -v powershell.exe >/dev/null 2>&1 \
        || die "this is a Windows shell but powershell.exe was not found; run this in PowerShell instead: irm https://raw.githubusercontent.com/${CIRCLE_REPO}/main/install.ps1 | iex"
    local ref="main"
    [[ -n "${CIRCLE_VERSION:-}" ]] && ref="v${CIRCLE_VERSION#v}"
    log "Windows ($(uname -s)): handing over to PowerShell to install the native Windows build"
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
        "irm 'https://raw.githubusercontent.com/${CIRCLE_REPO}/${ref}/install.ps1' | iex"
}

# The program's path relative to $1 (circle/circle or circle); prints nothing when there is none
program_in() {
    if [[ -x "$1/circle/circle" ]]; then
        printf 'circle/circle'
    elif [[ -f "$1/circle" && -x "$1/circle" ]]; then
        printf 'circle'
    fi
}

# Start the new program once before switching to it. A build that cannot run here leaves the
# previous install in place, and the slow first start of a new program (macOS checks each of
# its libraries once) happens now rather than on the first `circle`.
first_start() {
    local program="$1" out rc=0
    log "starting it once (the first start of a new version takes a few seconds)"
    out="$("$program" --version 2>&1)" || rc=$?
    if [[ $rc -ne 0 ]]; then
        printf '%s\n' "$out" | tail -5 >&2
        return 1
    fi
}

install_binary() {
    need_cmd curl
    need_cmd tar
    local version asset base tmp dest exe expected actual previous name keep fresh=""
    asset="$(detect_asset)"          # check the machine before going online
    version="$(resolve_version)"
    validate_version "$version"
    base="https://github.com/${CIRCLE_REPO}/releases/download/v${version}"
    dest="$PREFIX/versions/${version}"
    mkdir -p "$PREFIX/versions" "$BIN_DIR" "$HOME_DIR"
    rm -rf "$PREFIX"/versions/*.partial

    exe="$(program_in "$dest")"
    if [[ -n "$exe" ]]; then
        # Already installed, and possibly the copy that is running: leave it alone, only re-point
        log "version ${version} is already in ${dest}; not downloading it again (delete that folder to reinstall)"
    else
        tmp="$(mktemp -d)"
        TMP_DIR="$tmp"               # the EXIT trap runs after the function returns and cannot see a local
        trap 'rm -rf "$TMP_DIR"' EXIT

        log "downloading ${base}/${asset}"
        fetch "${base}/${asset}.sha256" "$tmp/expected.sha256"
        expected="$(awk '{print $1; exit}' "$tmp/expected.sha256")"
        [[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || die "${asset}.sha256 does not hold a sha256"
        fetch "${base}/${asset}" "$tmp/$asset"
        actual="$(sha256_of "$tmp/$asset")"
        [[ "$actual" == "$expected" ]] || die "sha256 mismatch (expected ${expected}, got ${actual}); nothing was installed"
        log "sha256 ok"

        rm -rf "$dest"               # what an interrupted install left
        mkdir -p "$dest.partial"
        tar -xzf "$tmp/$asset" -C "$dest.partial"
        mv "$dest.partial" "$dest"
        fresh=1
        exe="$(program_in "$dest")"
        if [[ -z "$exe" ]]; then
            rm -rf "$dest"
            die "${asset} does not hold the circle program"
        fi
    fi

    if ! first_start "$dest/$exe"; then
        [[ -n "$fresh" ]] && rm -rf "$dest"
        die "circle ${version} does not start on this machine (output above); nothing was changed"
    fi

    # The old layout (the 0.1.0 installer) made `current` a real folder, the copy that is running;
    # it can only be deleted to make way for the link.
    previous=""
    if [[ -L "$PREFIX/current" ]]; then
        previous="$(readlink "$PREFIX/current")"
    elif [[ -e "$PREFIX/current" ]]; then
        rm -rf "$PREFIX/current"
    fi
    ln -sfn "versions/${version}" "$PREFIX/current"
    ln -sfn "$PREFIX/current/$exe" "$BIN_DIR/circle"
    # Keep the three newest versions, the new one and the previous one: a session opened a few
    # updates ago still runs from its own folder.
    keep="$(ls -1 "$PREFIX/versions" | sort -t. -k1,1n -k2,2n -k3,3n | tail -3)"
    for d in "$PREFIX"/versions/*/; do
        name="${d%/}"; name="${name##*/}"
        if [[ "$name" != "$version" && "versions/$name" != "$previous" ]] \
            && ! grep -qx -- "$name" <<<"$keep"; then
            rm -rf "$d"
        fi
    done

    log "installed circle ${version}: ${BIN_DIR}/circle -> ${PREFIX}/current/${exe}"
    log "data folder: ${HOME_DIR} (the first run asks for your endpoint; the installer writes no settings)"
    log "update later with: circle update"

    if [[ ":$PATH:" == *":${BIN_DIR}:"* ]]; then
        log "done. Start it in a project folder:"
        log "  cd /path/to/project && circle"
    else
        local rc="$HOME/.zshrc"
        [[ "${SHELL:-}" == *bash* ]] && rc="$HOME/.bashrc"
        if ! grep -q '# circle path' "$rc" 2>/dev/null; then
            printf '\n# circle path\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
            log "added ${BIN_DIR} to PATH in ${rc}"
        fi
        log "done. Open a new terminal (or run: source ${rc}), then start it in a project folder:"
        log "  cd /path/to/project && circle"
    fi
}

main() {
    if [[ "${CIRCLE_FROM_SOURCE:-}" == "1" || "${1:-}" == "--from-source" ]]; then
        install_from_source
        return
    fi
    local os_tag
    os_tag="$(detect_os)"
    if [[ "$os_tag" == "windows" ]]; then
        install_windows
        return
    fi
    install_binary
}

main "$@"
