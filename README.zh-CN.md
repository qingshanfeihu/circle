<p align="center">
  <img src="docs/images/logo.svg" width="96" height="96" alt="Circle">
</p>

<h1 align="center">Circle</h1>

<p align="center">终端里的 AI coding agent，接你自己的模型网关。</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="docs/index.md">文档（英文）</a> ·
  <a href="docs/quickstart.md">快速开始</a> ·
  <a href="docs/known-issues.md">已知问题</a> ·
  <a href="CHANGELOG.md">更新记录</a>
</p>

---

Circle 在你指定的目录里读代码、改文件、跑命令。任何兼容 OpenAI 或 Anthropic 接口的服务或网关都能接。运行命令和改文件之前它会先问你，屏幕上一眼能看出它是在干活，还是在等你。

**Circle 还很早（0.5.0）。** 没有操作系统级沙箱，OAuth 登录不可用。把它用在重要的东西上之前，请先读[已知问题](docs/known-issues.md)和[安全使用](docs/security.md)。文档目前只有英文版。

## 安装

优先安装预编译版本，无需先安装 Python 环境。

**macOS**（Apple 芯片或 Intel）：

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

**Linux**（x86_64 或 arm64）：

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

**Windows**（x86_64），在 PowerShell 中运行：

```powershell
irm https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.ps1 | iex
```

安装器会下载适合当前平台的最新 Release，验证 SHA-256，并将 Circle 加入用户 PATH。macOS 和 Linux 需要 `bash`、`curl`、`tar`，以及 `sha256sum` 或 `shasum`；Linux 构建需要 glibc 2.35 或更新版本。Windows 需要 Windows 10（1809）或更新版本、PowerShell 5.1 或更新版本。没有原生 Windows ARM64 构建，x86_64 模拟运行尚未验证。

安装后重新打开终端，再运行 `circle`；以后用 `circle update` 升级。如果已安装旧版 `v0.1.0`，请先退出 Circle，再运行一次安装器迁移到新目录布局。详见[快速开始](docs/quickstart.md#1-install)、[发布页面](https://github.com/qingshanfeihu/circle/releases)和[已知问题](docs/known-issues.md#install-and-release)。Windows 控制台交互仍需真机测试。

## 运行

```bash
cd ~/code/my-project
circle
```

第一次会让你填 base URL、key 和模型，然后确认信任这个目录。之后输入任务按 `enter` 即可。输入 `/` 看命令，输入 `?` 看快捷键。

```bash
circle "修好失败的测试"                   # 带着第一句话启动
circle -c                                # 接着这个目录里上一次的对话
circle -r                                # 从列表里挑一个对话
circle -p "总结 README.md"               # 一次提问，答案写到 stdout
git diff | circle -p "审一下这个改动"
```

Circle 工作时可以继续打字：`enter` 会插话给正在进行的回合。空输入框连按两次 `esc` 回到对话里更早的位置，`ctrl+l` 换模型，`ctrl+f` 在对话里查找。[CLI](docs/cli.md) 还有给脚本和编辑器用的 JSON 事件流和 RPC 模式。

终端界面使用对话卡片、状态灯，以及跟随终端颜色的 `auto` 主题。如果终端不能报告颜色，可用 `/themes dark` 或 `/themes light` 手动指定。各信号的含义和限制见[界面说明](docs/interface.md)。

## 了解更多

| | |
|---|---|
| [快速开始](docs/quickstart.md) | 安装、接模型、跑第一个任务 |
| [界面](docs/interface.md) | 灯、底色、边框各代表什么 |
| [安全使用](docs/security.md) | 问什么、拒什么、不保护什么 |
| [选择模型](docs/models.md) | 网关、切换、思考深度 |
| [Skills](docs/skills.md)、[自定义命令](docs/custom-commands.md)、[MCP](docs/mcp.md)、[扩展](docs/extensions.md) | 让 Circle 适合你 |
| [全部文档](docs/index.md) | 指南与参考 |

## 开发

从源码安装或参与开发时才需要 Python 3.11 或更新版本（先用 `python3 --version` 查看；macOS 自带的是 3.9，要先装新版）：

```bash
git clone https://github.com/qingshanfeihu/circle
cd circle
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
python -m pytest -q
```

Windows PowerShell 中使用 `py -3 -m venv .venv` 和 `.venv\Scripts\Activate.ps1`。提交代码不会自动发布新版本：发布工作流由推送 `v*` tag 触发。详见[发布指南](docs/development/releasing.md)。

参见 [CONTRIBUTING.md](CONTRIBUTING.md)、给编码 agent 看的 [AGENTS.md](AGENTS.md) 和[架构](docs/development/architecture.md)。安全问题请按 [SECURITY.md](SECURITY.md) 报告。

## 许可证

尚未选定。
