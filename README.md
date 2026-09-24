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

Circle 兼容 [skills.sh](https://skills.sh) / Agent Skills 生态：和多数 harness 一样读 **`.agents/skills`**，并兼容 `.opencode/skills`、`.pi/skills`、`.claude/skills`。

安装（任选其一）：

```bash
# 推荐：装到通用 .agents/skills（Circle / Cursor / Codex 等都会读）
npx skills add <owner/repo> --skill <name> -a amp -y

# 或装到所有支持 .agents/skills 的 agent
npx skills add <owner/repo> --skill <name> -a amp,cursor,codex -y
```

Circle 还会额外读取：

| 位置 | 说明 |
|------|------|
| `~/.agents/skills/` · 项目 `.agents/skills/` | skills.sh 通用目录 |
| `~/.config/opencode/skills` · `.opencode/skills` | OpenCode |
| `~/.pi/agent/skills` · `.pi/skills` | Pi |
| `~/.circle/skills/` · `.circle/skills/` · `.agent/skills/` | Circle 私有目录 |

系统提示只放名称与简介；全文用 `read_file`、工具 `skill`，或 `/skill <name>` / `/skill:name`。

自定义 slash：在 `.circle/commands/*.md` 或 `.opencode/commands/*.md`（兼容 OpenCode frontmatter）。

MCP：在 `~/.circle/settings.json` 配置 `mcp_servers` 后会真正加载工具；`/mcp` 查看，`/mcp reload` 重连。

会话分支：`/tree` `/fork` `/clone`。Plan mode（`/plan`）硬拦截写改与 shell（仅允许 `/plan.md`）。

## Extensions

扩展是一段 Python，给 Circle 加工具、slash 命令、中间件、子代理、工具结果渲染和事件处理，不用改 Circle 本体。
一个扩展一个目录，里面的 `extension.py` 定义 `register(api)`：

| 位置 | 何时加载 |
|------|----------|
| `~/.circle/extensions/<name>/extension.py` | 总是 |
| 项目 `.circle/extensions/<name>/extension.py` | 仅当该工作区已受信任（`/trust`） |

```python
def register(api):
    def lookup(args):
        return {"ok": True, "hits": []}          # dict 以 JSON 返回给模型；抛 api.ToolError 表示失败
    api.register_tool("my_lookup", "Look something up.",
                      {"type": "object", "properties": {"q": {"type": "string"}}},
                      lookup, read_only=True)    # 非只读工具走审批，与 execute/write 一致
    api.register_command("hello", "Say hello", lambda args, ctx: ctx.toast("hello " + args))
```

其余接口：`register_middleware(mw, slot)`（`model_call` / `tool_boundary` / `after_model`）、
`register_subagent(spec, tools=[工具名])`（工具白名单）、`register_renderer("tool_result:<工具名>", fn)`、
`on(event, handler)`（`session_start` / `turn_start` / `turn_end` / `tool_result`）。
工具或命令与内置重名会被拒绝；`register` 抛异常时这个扩展整体不加载，不影响其他扩展。
`/extensions` 查看状态，`/extensions reload` 重新加载；`~/.circle/settings.json` 里
`"extensions": {"<name>": {"enabled": false}}` 关闭某个扩展。

## Dev

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e .
pytest -q
```
