# 兼容要求与迁移计划

## 固定参考

Circle 0.4.0，提交 `645ac4357fa4e7977c2812b133be8d65c277bf0b`。关键文件的字节哈希见 [baseline.json](baseline.json)。下列链接固定在该提交：

- [TUI 显示与交互契约](https://github.com/qingshanfeihu/circle/blob/645ac4357fa4e7977c2812b133be8d65c277bf0b/docs/development/tui-contract.md)
- [界面说明](https://github.com/qingshanfeihu/circle/blob/645ac4357fa4e7977c2812b133be8d65c277bf0b/docs/interface.md)、[键位](https://github.com/qingshanfeihu/circle/blob/645ac4357fa4e7977c2812b133be8d65c277bf0b/docs/keybindings.md)
- [CLI](https://github.com/qingshanfeihu/circle/blob/645ac4357fa4e7977c2812b133be8d65c277bf0b/docs/cli.md)、[会话](https://github.com/qingshanfeihu/circle/blob/645ac4357fa4e7977c2812b133be8d65c277bf0b/docs/sessions.md)
- [配置](https://github.com/qingshanfeihu/circle/blob/645ac4357fa4e7977c2812b133be8d65c277bf0b/docs/configuration.md)、[架构](https://github.com/qingshanfeihu/circle/blob/645ac4357fa4e7977c2812b133be8d65c277bf0b/docs/development/architecture.md)

文档与实现不一致时，先记录可复现差异，再决定兼容行为；不能静默改变操作语义。

## 必须保持的用户体验

| 范围 | 验收要求 |
|---|---|
| 屏幕 | 保持欢迎块、转录、页眉、计划区、唯一输入/对话框、页脚、子代理条的布局和生命周期 |
| 信号 | 保持彩虹框、状态灯、类型底色、忙碌词、`read-only`/`auto`，兼容自动深浅主题 |
| 输入 | 保持多行草稿、中文宽度、粘贴、历史、补全、搜索和窗口尺寸变化行为 |
| 操作 | 保持 Enter 插话、空框双 Esc 会话树、Ctrl+L 模型选择、Ctrl+O 工具展开、Ctrl+T 思考展开和用户键位配置 |
| 对话 | 保持首次设置、信任、工具审批、问题和机密输入；卡片结束后恢复草稿 |
| 命令 | 逐项核对原斜杠命令和 CLI 参数，包括 new/resume/tree/fork/clone、plan/yolo、compact/export/import |
| 非交互 | 保持 line/print/JSON/RPC 的输出、排队、错误和退出码；结构变化须明确迁移 |
| 配置 | 保持模型、网关、项目资源和信任操作；旧文件读取、会话导入、Python 扩展迁移单独验证 |

保留操作不等于复制所有内部格式或历史缺陷。例如基线 `/undo` 只调整视图，`/tree` 改变模型的分支上下文；若要改变其中任何语义，须单独提出并获用户授权。

## 实施顺序

1. **冻结兼容基线。** 从现有测试和独立终端会话提取输入、事件、屏幕和副作用样例；记录已知缺陷。只读参考旧项目。
2. **建立 TypeScript 工程。** 确定运行时、依赖与锁文件，加入格式化、静态检查、测试和 CI。暂不替换用户已有安装。
3. **实现最小自有内核。** 以可控模型响应验证请求、流式工具调用、策略、审批、取消和队列；接通非交互入口。
4. **实现会话与上下文。** 验证重启、树、分支、压缩、导入导出和旧数据迁移，避免导入时重放工具。
5. **移植 TUI。** 按原界面契约接入事件；对照深/浅色、窄/宽屏、中文、多行和等待用户状态。
6. **补齐集成并验收。** MCP、skills、命令、扩展、子代理与安装升级分别验证；完成后再声明可替换旧 Circle。

以上均为待完成工作，不表示已有实现。

## 验证要求

每个迁移项包含可复现输入、预期行为、测试和实际验证结果。内核检查必须覆盖下一次真实模型请求、持久化历史、文件副作用、子进程终止和重启恢复；仅有正确界面文本不够。

TUI 验收对照同一终端尺寸与主题下的参考输出，结合真实 PTY 按键流程与人工观察。针对审批、取消、排队和分支建立行为测试；覆盖旧测试关注的边界，而非只移植断言文本。

真实模型、网关、操作系统、终端和扩展只按实际验证范围报告兼容性。未验证项保持待验收，不继承旧项目的测试通过或平台支持声明。
