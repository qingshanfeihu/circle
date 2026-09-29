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

**Circle 还很早（0.1.x）。** 没有操作系统级沙箱，OAuth 登录不可用，重启后不能恢复旧会话。把它用在重要的东西上之前，请先读[已知问题](docs/known-issues.md)和[安全使用](docs/security.md)。文档目前只有英文版。

## 安装

需要 macOS 或 Linux，以及 Python 3.11 或更新版本。

```bash
git clone https://github.com/qingshanfeihu/circle
cd circle
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pip install -e .
```

也有预编译的二进制和安装脚本，但目前唯一的发布版本较旧，只有 macOS Apple 芯片的包。用之前请看[快速开始](docs/quickstart.md#1-install)。

## 运行

```bash
cd ~/code/my-project
circle
```

第一次会让你填 base URL、key 和模型，然后确认信任这个目录。之后输入任务按 `enter` 即可。输入 `/` 看命令，输入 `?` 看快捷键。

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

```bash
pip install -e '.[dev]'
python -m pytest -q
```

参见 [CONTRIBUTING.md](CONTRIBUTING.md)、给编码 agent 看的 [AGENTS.md](AGENTS.md) 和[架构](docs/development/architecture.md)。安全问题请按 [SECURITY.md](SECURITY.md) 报告。

## 许可证

尚未选定。
