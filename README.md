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

子代理（`task`）运行时，底部在途条每行一个：名字、在做什么（思考标题，没有就是派给它的任务）、耗时、token，
最多显示 6 行，超出的折叠并注明条数。输入框为空时按 ↓ 进入选择，↑↓ 移动，⏎（或点击该行）打开它的详情页：
逐次工具调用与结果、每轮思考（`ctrl+t` 展开正文，只保留每轮末尾一段），←→ 切换到其他子代理，esc 返回。
主对话里 task 行下面折叠显示子代理的调用次数、耗时、token，运行中再列最近 3 次调用，`ctrl+o` 列出全部。

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

## 审批

`execute`、`write_file`、`edit_file`、`apply_patch`、`delete` 和非只读的扩展工具先经审批。每次调用按内容分三类：

| 判定 | 哪些调用 | 行为 |
|------|----------|------|
| 拒绝 | `sudo`/`su`/`doas`/`pkexec`；点名凭据文件的命令（默认 `.env*`、`*.pem`、`id_rsa`、`credentials.json`、`token.json` 等） | 不弹审批、不执行，模型收到拒绝原因；由 sandbox 后端在执行前拦截，子代理同样生效 |
| 每次都问 | 删除（`rm`、`find -delete`、`delete` 工具、删文件的补丁）、破坏性 git（`reset --hard`、`clean -f`、强推、`branch -D`、丢弃改动）、`dd`/`mkfs`/`truncate`、无法解析的命令 | 审批面板没有「始终允许」 |
| 询问 | 其余 | 可选「始终允许」：命令按原文精确匹配；文件改动只覆盖工作区内的路径；扩展工具覆盖该工具的全部调用 |

「始终允许」按会话线程记在 `~/.circle/approvals/`（命令只存哈希），重启或 `/resume` 后仍然有效；
`/approvals` 列出本会话的规则，`/approvals revoke <序号>` 撤销。凭据文件表可在 `settings.json` 用
`"credential_files": ["*.secret", ".env*"]` 替换（按文件名通配）。命令分类只读命令文本，能覆盖常见写法，
挡不住有意的变形。

## 运行守卫

全屏界面运行时，日志写入 `~/.circle/logs/circle.log`（5 MB 轮转三份），不输出到终端。

- 工具抛出异常时，模型收到一条脱敏后的错误结果，回合继续。
- 工具名大小写、参数键拼写、JSON 字符串字段会先修正再执行；参数仍不合 schema 时不执行，告诉模型哪些字段错。
- 模型重复同一调用、连续拿到空结果或来回重读同一文件时，会收到换思路的提醒（`CIRCLE_LOOP_GUARD=0` 关闭；
  阈值 `CIRCLE_LOOP_DUP_THRESHOLD` / `CIRCLE_LOOP_EMPTY_THRESHOLD` / `CIRCLE_LOOP_WINDOW` / `CIRCLE_LOOP_SOFT_BUDGET`）。
- 长会话里较早的大段工具输出只保留开头（`CIRCLE_PRUNE_TOOL_OUTPUTS=0` 关闭，`CIRCLE_PRUNE_PROTECT_TOKENS` 调保护窗口）。

模型请求（`circle/model_guard.py`）：

- 失败按类型分别重试：限流（429）、服务端错误（408/409/5xx）、网络中断、流内报错，各有次数与总时长上限；
  端点给了 `Retry-After` 就按它等。欠费（402、`insufficient_quota`）不重试。已经输出过内容的请求不重试，
  避免同一段文字出现两次。等待时会话里会提示。
- 端点以 400/422 拒收某个参数（effort、thinking、betas、stream_options 等）时，去掉它重发，本会话之后都不再发送。
- 流只剩保活、`CIRCLE_LLM_STALL_TIMEOUT` 秒（默认 180）没有内容时断开；还没产出内容就重发一次。
- 输出陷入复读：还没给出正文或工具调用时，附一条提醒重发（最多两次）；已经有正文就在此处结束。
  `CIRCLE_LLM_REPEAT_GUARD=0` 关闭。
- 流结束却没有 finish_reason：没内容就重发一次；有内容则保留，并记日志说明可能被截断。

思考深度 `CIRCLE_REASONING_EFFORT`（Anthropic 协议缺省 `xhigh`）按模型族落地：
声明了档位的模型取不超过所请求的最高档；老一代 Claude 改发思考预算；
模型目录里还没有的 Claude 型号按新一代处理，发自适应思考加 effort。
OpenAI 协议只有显式设置了才发送。Circle 不会关闭思考。

## Dev

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e .
pytest -q
```
