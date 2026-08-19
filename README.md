# Feishu Chat Export

一个面向本地使用的飞书网页聊天记录导出 CLI：通过你自己的浏览器 Cookie 打开飞书网页，按日期或增量提取消息，输出结构化 JSON，并可生成适合交给 AI 的 Markdown 汇总。

它不需要把个人 App Secret、Token 或 Cookie 写进项目，也不会把认证信息上传到任何服务。Cookie 只在本机注入临时 Chrome 配置目录；请仅导出你有权访问的聊天内容，并遵守所在组织的隐私和数据留存政策。

## 快速开始

需要 Node.js 22+、Google Chrome/Chromium，以及浏览器导出的 Cookie JSON。

```bash
git clone https://github.com/<your-account>/feishu-chat-export.git
cd feishu-chat-export

# 推荐：把 Cookie 放到用户配置目录（权限应为 600）
mkdir -p "$HOME/Library/Application Support/feishu-export"
cp ~/Downloads/feishu-cookies.json "$HOME/Library/Application Support/feishu-export/cookies.json"
chmod 600 "$HOME/Library/Application Support/feishu-export/cookies.json"

# 中国大陆飞书租户
FEISHU_BASE_URL=https://your-tenant.feishu.cn ./bin/feishu-export --today --markdown
```

也可以始终显式指定 Cookie：

```bash
./bin/feishu-export --cookies ~/Downloads/feishu-cookies.json --date 2026-08-20
```

首次建议用 `--limit-chats 2` 做小范围验证。默认输出在 `~/feishu_export/daily`，该目录已被 `.gitignore` 忽略。

## 支持的模式

| 命令 | 作用 |
| --- | --- |
| `--today` | 今天 00:00 至今（默认） |
| `--date YYYY-MM-DD` | 导出某一天 |
| `--since YYYY-MM-DD[THH:MM]` | 从某时间点至今；可配 `--to` |
| `--range START END` | 导出闭区间日期范围 |
| `--incremental` | 从状态文件中的上次游标继续 |
| `--markdown` | 同时生成 Markdown 汇总 |
| `--refresh-chats` | 强制重新扫描会话列表 |
| `--limit-chats N` | 只处理前 N 个会话，便于试跑 |
| `--no-headless` | 显示 Chrome 窗口，便于排查页面兼容性 |
| `--base-url URL` | 指定飞书租户地址；也可用 `FEISHU_BASE_URL` |

单个会话读取默认有 45 秒预算，避免一个异常或超大群拖死整批导出；超时会把该会话标记为失败，命令以非零状态结束且不会推进增量游标。生成的 JSON/Markdown 仍会保留，方便诊断，但不会被当作完整来源。可按机器和网络情况调整：

```bash
FEISHU_CHAT_TIMEOUT_MS=90000 ./bin/feishu-export --today --markdown
```

增量状态默认写入输出目录的 `.state.json`。导出完成且存在消息时才推进游标；`--no-update-state` 可用于只读试跑。

## 安全说明

- 不要提交 Cookie、导出 JSON/Markdown、聊天截图、日志或 `.env`。仓库已默认忽略这些文件，但提交前仍应检查 `git diff --cached`。
- CLI 会拒绝读取权限对其他用户开放的 Cookie 文件（Unix 上应为 `600`）。
- Cookie 会过期；失效时重新从浏览器导出，不要把 Cookie 粘贴到 Issue、PR 或聊天里。
- 这是基于飞书网页端内部数据 Store 的本地工具，网页改版可能导致兼容性中断；遇到不兼容时请先用 `--no-headless` 复现并提交不含个人数据的错误信息。
- 公开发布不代表获得访问聊天内容的授权。请自行确认组织政策、当地法规和飞书服务条款。

## 设计取舍

工具刻意保持“本地浏览器会话 + 无第三方服务”的模式：不保存长期 Token，不维护服务端账号，也不把聊天内容上传到作者的服务器。这样牺牲了后台定时运行的便利，但更适合个人/团队内部把聊天上下文交给自己的 AI 工作流。

## 开发

```bash
npm test
```

如果飞书前端改版，优先检查 `export_lib.mjs` 中的页面 Store 和 DOM 选择器。请只提交通用修复，不要提交本地导出结果或诊断脚本中的个人数据。
