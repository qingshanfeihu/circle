#!/usr/bin/env bash
# Circle 一键安装：从 GitHub Releases 拉取 PyInstaller onedir 资产。
#
#   curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
#
# 真实形态（调研定稿）：下载平台二进制 → ~/.local/bin → 幂等写 shell rc。
# 不依赖本机 Python。开发可设 CIRCLE_FROM_SOURCE=1 走源码 editable 安装。
#
# 环境变量:
#   CIRCLE_REPO       默认 qingshanfeihu/circle
#   CIRCLE_VERSION    钉死版本（1.0.0 或 v1.0.0）；未设取最新 Release
#   CIRCLE_BIN_DIR    默认 ~/.local/bin
#   CIRCLE_PREFIX     onedir 解压根，默认 ~/.local/share/circle
#   CIRCLE_HOME       运行时数据根，默认 ~/.circle（安装器只创建空目录）
#   CIRCLE_FROM_SOURCE 设为 1 时对本仓库做 pip install -e（开发用）

set -euo pipefail

CIRCLE_REPO="${CIRCLE_REPO:-qingshanfeihu/circle}"
GITHUB_API="https://api.github.com/repos/${CIRCLE_REPO}"
BIN_DIR="${CIRCLE_BIN_DIR:-$HOME/.local/bin}"
PREFIX="${CIRCLE_PREFIX:-$HOME/.local/share/circle}"
HOME_DIR="${CIRCLE_HOME:-$HOME/.circle}"

log()  { printf '[circle-install] %s\n' "$*" >&2; }
warn() { printf '[circle-install] 警告: %s\n' "$*" >&2; }
die()  { printf '[circle-install] 错误: %s\n' "$*" >&2; exit 1; }

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

detect_asset() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"
    case "$os" in
        Darwin) os_tag="darwin" ;;
        Linux)  os_tag="linux" ;;
        *) die "暂不支持的 OS: $os（请等 Windows 档或从源码安装）" ;;
    esac
    case "$arch" in
        x86_64|amd64) arch_tag="x86_64" ;;
        arm64|aarch64) arch_tag="arm64" ;;
        *) die "暂不支持的 arch: $arch" ;;
    esac
    # asset: circle-linux-x86_64.tar.gz
    printf 'circle-%s-%s.tar.gz' "$os_tag" "$arch_tag"
}

resolve_version() {
    if [[ -n "${CIRCLE_VERSION:-}" ]]; then
        local v="${CIRCLE_VERSION#v}"
        printf '%s' "$v"
        return
    fi
    need_cmd curl
    local tag
    tag="$(curl -fsSL "${GITHUB_API}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
    [[ -n "$tag" ]] || die "无法解析最新 Release（仓库 ${CIRCLE_REPO}）"
    printf '%s' "${tag#v}"
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

install_binary() {
    need_cmd curl
    need_cmd tar
    local version asset url tmp
    version="$(resolve_version)"
    asset="$(detect_asset)"
    url="https://github.com/${CIRCLE_REPO}/releases/download/v${version}/${asset}"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT

    log "下载 $url"
    curl -fsSL "$url" -o "$tmp/$asset"
    curl -fsSL "${url}.sha256" -o "$tmp/${asset}.sha256"
    if command -v shasum >/dev/null 2>&1; then
        (cd "$tmp" && shasum -a 256 -c "${asset}.sha256") || die "资产校验失败"
    else
        (cd "$tmp" && sha256sum -c "${asset}.sha256") || die "资产校验失败"
    fi
    mkdir -p "$PREFIX" "$BIN_DIR" "$HOME_DIR"
    local generation="${PREFIX}/versions/${version}-${asset%.tar.gz}-$(date +%s)"
    mkdir -p "$generation"
    tar -xzf "$tmp/$asset" -C "$generation"
    # onedir 内预期为 circle/circle 或顶层 circle
    local exe
    if [[ -x "$generation/circle/circle" ]]; then
        exe="$generation/circle/circle"
    elif [[ -x "$generation/circle" ]]; then
        exe="$generation/circle"
    else
        die "Release 资产布局异常：未找到可执行文件 circle"
    fi
    CIRCLE_HOME="$tmp/smoke-home" "$exe" --version >/dev/null || die "新版本启动检查失败"
    # Retain the previous generation. Existing legacy directories are moved
    # aside, never deleted before a verified replacement is available.
    if [[ -e "$PREFIX/current" && ! -L "$PREFIX/current" ]]; then
        mv "$PREFIX/current" "$PREFIX/legacy-$(date +%s)"
    fi
    ln -s "$generation" "$PREFIX/.current-next-$$"
    case "$(uname -s)" in
        Darwin) mv -f -h "$PREFIX/.current-next-$$" "$PREFIX/current" ;;
        Linux) mv -f -T "$PREFIX/.current-next-$$" "$PREFIX/current" ;;
    esac
    # Invoke the real script path so its relative runtime lookup survives the
    # user's bin directory and spaces in the installation prefix.
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$exe" > "$BIN_DIR/.circle-next-$$"
    chmod +x "$BIN_DIR/.circle-next-$$"
    mv -f "$BIN_DIR/.circle-next-$$" "$BIN_DIR/circle"
    log "已安装: ${BIN_DIR}/circle → ${exe}"
    log "数据根: ${HOME_DIR}（凭据与 settings 由首次运行写入，安装器不写配置）"

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
    if [[ "${CIRCLE_FROM_SOURCE:-}" == "1" ]] || [[ -f "$(dirname "$0")/pyproject.toml" && "${1:-}" == "--from-source" ]]; then
        install_from_source
        return
    fi
    if [[ -f "$(dirname "$0")/pyproject.toml" && ! -t 0 ]]; then
        # curl|bash 不会带上本地 pyproject；本地 ./install.sh 默认仍走二进制，
        # 明示开发安装用: ./install.sh --from-source
        :
    fi
    if [[ "${1:-}" == "--from-source" ]]; then
        install_from_source
        return
    fi
    install_binary
}

main "$@"
