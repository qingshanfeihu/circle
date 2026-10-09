# Circle

使用 TypeScript 编写的终端 AI coding agent，连接你自己的模型端点。

## 开发

需要 Node.js 24 或更新版本。编译器与依赖安装在项目内，版本由锁文件固定。

```bash
npm ci
npm run check
npm run dev -- --version
```

开发时使用独立数据目录：

```bash
CIRCLE_HOME=$(mktemp -d) npm run dev -- ~/code/my-project
```

首次运行设置 API URL、key 和模型，并确认工作区信任。输入 `/help` 查看命令；界面沿用对话、计划、唯一输入/对话框、状态灯与自动深浅主题的操作风格。

`npm run build` 生成 `dist/`；之后使用 `node dist/cli.js`。`npm test` 验证模型与工具循环、实际副作用、取消、持久化和终端组件；`npm run format` 格式化源码。

## 当前状态

当前是开发版本。已有独立内核、CLI、模型流、文件与命令工具、审批、会话存储与终端界面实现。完整功能兼容、多平台打包、一键安装和首版发布仍在进行中。

见[架构](docs/architecture.md)、[开发说明](docs/development/README.md)和[已知问题](docs/known-issues.md)。
