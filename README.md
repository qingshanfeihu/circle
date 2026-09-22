# Circle

终端里的编译 / 编码助手。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

钉版本：

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/v0.1.0/install.sh | CIRCLE_VERSION=0.1.0 bash
```

## 使用

```bash
circle
# 或
circle /path/to/project
```

1. 首次初始化：API URL+KEY 或 OAuth → 选模型  
2. Trust 当前工作区  
3. 进入主界面对话（`/help` 查看命令）

配置写在 `~/.circle/`（可用 `CIRCLE_HOME` 覆盖）。

## 开发

```bash
python3.11 -m venv .venv311
source .venv311/bin/activate
pip install -r requirements.txt
pip install -e .
pytest -q
```
