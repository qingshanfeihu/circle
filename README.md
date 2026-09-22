# Circle

终端里的 AI coding agent。接你自己的模型网关，在项目目录里读改跑。

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

钉版本：

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/v0.1.0/install.sh | CIRCLE_VERSION=0.1.0 bash
```

## Quick start

```bash
circle
# 或指定目录
circle ~/code/my-project
```

第一次会引导你接模型（URL + KEY 或 OAuth），再确认 trust 当前工作区，然后进入会话。之后在同一台机器上直接 `circle` 即可。

配置与凭据在 `~/.circle/`（可用环境变量 `CIRCLE_HOME` 改路径）。

## Commands

会话里输入 `/` 查看全部命令，常用：

| Command | 作用 |
|---------|------|
| `/help` | 命令列表 |
| `/login` `/logout` | 登录 / 退出（`/connect` = `/login`） |
| `/models` | 查看或切换模型 |
| `/new` | 新会话（`/clear` 同义） |
| `/resume` | 恢复会话（`/sessions` 同义） |
| `/compact` | 压缩上下文（`/summarize` 同义） |
| `/plan` | 开关 plan mode（优先探索与写 `/plan.md`；变更仍需确认） |
| `/export` `/share` | 导出 / 本地分享副本 |
| `/undo` `/redo` | 撤销 / 重做上一回合 |
| `/hotkeys` | 快捷键说明 |
| `/exit` | 退出（`/quit` `/q`） |

快捷键：`ctrl+t` 展开思考 · `ctrl+o` 展开工具输出 · `ctrl+r` 历史搜索 · ↑↓ 提示历史。

## Skills

Circle 按 Agent Skills 约定加载 `SKILL.md`（YAML frontmatter + 说明）：

| 位置 | 说明 |
|------|------|
| `~/.circle/skills/<name>/SKILL.md` | 用户级 |
| `~/.agents/skills/…` | 本机共享 |
| `.agent/skills/` · `.circle/skills/` · `.agents/skills/` | 项目级（后者会向上找到 git 根） |

系统提示里只放名称与简介；需要全文时用 `read_file`、工具 `skill`，或会话里 `/skill <name>`。

## Dev

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e .
pytest -q
```
