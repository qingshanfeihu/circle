#!/usr/bin/env bash
# Circle 一键安装：从 GitHub Releases 拉取 PyInstaller onedir 资产。
#
#   curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
#
# 下载当前平台的二进制 → 校验 sha256 → 解到 ~/.local/share/circle/versions/<版本>，
# current 指向它，~/.local/bin/circle 指向 current。目录布局与 `circle update` 共用。
# 不依赖本机 Python。开发可设 CIRCLE_FROM_SOURCE=1 走源码 editable 安装。
#
# Windows 的 shell（Git Bash、MobaXterm、Cygwin、MSYS）里运行时，转交 PowerShell 执行
# install.ps1，装原生 Windows 版。
#
# 环境变量:
#   CIRCLE_REPO       默认 qingshanfeihu/circle
#   CIRCLE_VERSION    钉死版本（1.0.0 或 v1.0.0）；未设取最新 Release
#   CIRCLE_BIN_DIR    默认 ~/.local/bin
#   CIRCLE_PREFIX     安装根，默认 ~/.local/share/circle
#   CIRCLE_HOME       运行时数据根，默认 ~/.circle（安装器只创建空目录）
#   CIRCLE_FROM_SOURCE 设为 1 时对本仓库做 pip install -e（开发用）
#   CURL_CA_BUNDLE    curl 用的 CA 证书文件（PEM）；网络劫持 HTTPS 时指向含代理根证书的文件

set -euo pipefail

CIRCLE_REPO="${CIRCLE_REPO:-qingshanfeihu/circle}"
BIN_DIR="${CIRCLE_BIN_DIR:-$HOME/.local/bin}"
PREFIX="${CIRCLE_PREFIX:-$HOME/.local/share/circle}"
HOME_DIR="${CIRCLE_HOME:-$HOME/.circle}"
TMP_DIR=""

log()  { printf '[circle-install] %s\n' "$*" >&2; }
warn() { printf '[circle-install] 警告: %s\n' "$*" >&2; }
die()  { printf '[circle-install] 错误: %s\n' "$*" >&2; exit 1; }

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

# 按 curl 的退出码说明原因和办法；调用方已经拿到了失败状态。
explain_curl_failure() {
    local rc="$1" url="$2"
    case "$rc" in
        35|51|58|60|77|82|83)
            warn "TLS 证书校验失败（curl 退出码 $rc）：$url"
            warn "多半是公司代理/网关替换了 HTTPS 证书，而系统证书库里没有它的根证书。"
            warn "把根证书导出为 PEM 文件后重试：CURL_CA_BUNDLE=/path/to/ca.pem <重新执行安装命令>"
            warn "不建议用 curl -k 跳过校验：下载的是要执行的程序。"
            ;;
        22)
            warn "服务器返回了错误（HTTP 4xx/5xx）：$url"
            warn "该版本可能没有适合本机的文件，看 https://github.com/${CIRCLE_REPO}/releases"
            ;;
        6|7|28|56)
            warn "连不上 $url（curl 退出码 $rc）。需要代理时设 HTTPS_PROXY。"
            ;;
        *)
            warn "下载失败（curl 退出码 $rc）：$url"
            ;;
    esac
}

# fetch URL DEST —— 失败时给出原因，然后退出
fetch() {
    local url="$1" dest="$2" rc=0
    curl -fsSL "$url" -o "$dest" || rc=$?
    if [[ $rc -ne 0 ]]; then
        explain_curl_failure "$rc" "$url"
        die "下载失败"
    fi
}

detect_os() {
    case "$(uname -s)" in
        Darwin) printf 'darwin' ;;
        Linux)  printf 'linux' ;;
        MINGW*|MSYS*|CYGWIN*) printf 'windows' ;;
        *) die "暂不支持的 OS: $(uname -s)" ;;
    esac
}

detect_asset() {
    local os_tag arch arch_tag
    os_tag="$(detect_os)"
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) arch_tag="x86_64" ;;
        arm64|aarch64) arch_tag="arm64" ;;
        *) die "暂不支持的 arch: $arch" ;;
    esac
    # asset: circle-linux-x86_64.tar.gz
    printf 'circle-%s-%s.tar.gz' "$os_tag" "$arch_tag"
}

# 取最新 Release 的版本号：跟随 /releases/latest 的跳转，不走 API（没有匿名限流）。
validate_version() {
    [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+.]?[0-9A-Za-z][0-9A-Za-z.+-]*)?$ ]] \
        || die "无效版本: $1（应为 0.2.0 这样的版本号）"
}

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
        die "无法解析最新 Release（仓库 ${CIRCLE_REPO}）"
    fi
    [[ "$final" == */releases/tag/* ]] || die "仓库 ${CIRCLE_REPO} 还没有发布 Release"
    final="${final##*/}"
    printf '%s' "${final#v}"
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        die "缺少 sha256sum 或 shasum，无法校验下载"
    fi
}

install_from_source() {
    need_cmd python3
    local root
    root="$(cd "$(dirname "$0")" && pwd)"
    log "开发安装: pip install -e $root"
    python3 -m pip install -U pip setuptools wheel
    python3 -m pip install -e "$root"
    mkdir -p "$BIN_DIR" "$HOME_DIR"
    if ! command -v circle >/dev/null 2>&1; then
        warn "circle 不在 PATH；请确认 pip scripts 目录已加入 PATH"
    fi
    log "数据根: $HOME_DIR（settings.json 由首次 circle 写入）"
    log "开始使用: circle"
}

# Windows 的 shell 里运行本脚本：装原生 Windows 版，交给 PowerShell。
# PowerShell 用 Windows 证书库，公司根证书通常已经在里面。
install_windows() {
    command -v powershell.exe >/dev/null 2>&1 \
        || die "在 Windows 的 shell 里但找不到 powershell.exe；请直接在 PowerShell 里运行: irm https://raw.githubusercontent.com/${CIRCLE_REPO}/main/install.ps1 | iex"
    local ref="main"
    [[ -n "${CIRCLE_VERSION:-}" ]] && ref="v${CIRCLE_VERSION#v}"
    log "检测到 Windows（$(uname -s)）：交给 PowerShell 安装原生 Windows 版"
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
        "irm 'https://raw.githubusercontent.com/${CIRCLE_REPO}/${ref}/install.ps1' | iex"
}

# 相对 $1 的可执行文件路径（circle/circle 或 circle）；没有则不输出
program_in() {
    if [[ -x "$1/circle/circle" ]]; then
        printf 'circle/circle'
    elif [[ -f "$1/circle" && -x "$1/circle" ]]; then
        printf 'circle'
    fi
}

install_binary() {
    need_cmd curl
    need_cmd tar
    local version asset base tmp dest exe expected actual previous name keep
    asset="$(detect_asset)"          # 先判断系统，再联网
    version="$(resolve_version)"
    validate_version "$version"
    base="https://github.com/${CIRCLE_REPO}/releases/download/v${version}"
    dest="$PREFIX/versions/${version}"
    mkdir -p "$PREFIX/versions" "$BIN_DIR" "$HOME_DIR"
    rm -rf "$PREFIX"/versions/*.partial

    exe="$(program_in "$dest")"
    if [[ -n "$exe" ]]; then
        # 这个版本已经装好（可能正在运行）：不动它，只重新指向
        log "版本 ${version} 已在 ${dest}，不重新下载；要重装请先删掉这个目录"
    else
        tmp="$(mktemp -d)"
        TMP_DIR="$tmp"               # EXIT trap 在函数返回后运行，看不到 local
        trap 'rm -rf "$TMP_DIR"' EXIT

        log "下载 ${base}/${asset}"
        fetch "${base}/${asset}.sha256" "$tmp/expected.sha256"
        expected="$(awk '{print $1; exit}' "$tmp/expected.sha256")"
        [[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || die "${asset}.sha256 的内容不是 sha256"
        fetch "${base}/${asset}" "$tmp/$asset"
        actual="$(sha256_of "$tmp/$asset")"
        [[ "$actual" == "$expected" ]] || die "sha256 不符（期望 ${expected}，实际 ${actual}），未安装"
        log "sha256 校验通过"

        rm -rf "$dest"               # 上次没装完的残留
        mkdir -p "$dest.partial"
        tar -xzf "$tmp/$asset" -C "$dest.partial"
        mv "$dest.partial" "$dest"
        exe="$(program_in "$dest")"
        if [[ -z "$exe" ]]; then
            rm -rf "$dest"
            die "Release 资产布局异常：未找到可执行文件 circle"
        fi
    fi

    # 旧布局（0.1.0 的安装器）把 current 建成真目录，它就是正在运行的那份；换成链接时只能删掉它。
    previous=""
    if [[ -L "$PREFIX/current" ]]; then
        previous="$(readlink "$PREFIX/current")"
    elif [[ -e "$PREFIX/current" ]]; then
        rm -rf "$PREFIX/current"
    fi
    ln -sfn "versions/${version}" "$PREFIX/current"
    ln -sfn "$PREFIX/current/$exe" "$BIN_DIR/circle"
    # 留最新的三个版本、刚装的和上一个：几次升级前打开的会话还在用自己的目录。
    keep="$(ls -1 "$PREFIX/versions" | sort -t. -k1,1n -k2,2n -k3,3n | tail -3)"
    for d in "$PREFIX"/versions/*/; do
        name="${d%/}"; name="${name##*/}"
        if [[ "$name" != "$version" && "versions/$name" != "$previous" ]] \
            && ! grep -qx -- "$name" <<<"$keep"; then
            rm -rf "$d"
        fi
    done

    log "已安装: ${BIN_DIR}/circle → ${PREFIX}/current/${exe}（版本 ${version}）"
    log "数据根: ${HOME_DIR}（凭据与 settings 由首次运行写入，安装器不写配置）"
    log "以后升级: circle update"

    if [[ ":$PATH:" == *":${BIN_DIR}:"* ]]; then
        log "安装完成。开始使用："
        log "  circle            # 首跑初始化 → trust 工作区 → 主界面"
        log "  circle /path/to/project"
    else
        local rc="$HOME/.zshrc"
        [[ "${SHELL:-}" == *bash* ]] && rc="$HOME/.bashrc"
        if ! grep -q '# circle path' "$rc" 2>/dev/null; then
            printf '\n# circle path\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
            log "已将 ${BIN_DIR} 写入 ${rc}"
        fi
        log "安装完成。当前终端生效：source ${rc} （或重开终端）"
        log "然后运行: circle"
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
