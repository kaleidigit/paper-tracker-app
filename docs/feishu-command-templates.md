# 飞书命令模板说明（Host 推送模式）

当前默认模式：`feishu.execution_mode=host`。  
即由本机 Node.js 进程直接调用本机 `lark-cli` 执行飞书 API 命令。

配置入口统一在 `config.json` 的 `feishu.*`，认证与权限由本机 `lark-cli` 账号状态决定。

## 1. 可用占位符

- `{title}`：带前缀后的文档标题（已做 shell 安全转义）
- `{markdown_file}`：日报 Markdown 文件路径
- `{records_file}`：多维表格记录 JSON 文件路径
- `{papers_file}`：完整增强论文 JSON 文件路径
- `{notify_chat_id}`：通知用 chat_id（来自 `feishu.notify_chat_id`）
- `{notify_user_id}`：通知用 user_id（来自 `feishu.notify_user_id`）
- `{doc_url}`：文档发布成功后自动提取的链接（若能提取到）
- `{notify_text}`：通知消息文本（由 `notify_message_template` 组装）

## 2. 默认文档推送模板

```text
lark-cli docs +create --as bot --title {title} --markdown "$(cat {markdown_file})"
```

说明：

- `docs +create` 需要 markdown 字符串，因此模板中读取本机文件内容。
- 若在 Windows 环境，建议把命令模板改为 PowerShell 等价写法。

## 3. Base 推送模板

默认 `base_enabled=false`。你配置好 Base 后再开启。

可先写一个占位模板进行 dry-run，然后按你的表结构替换为真实命令。建议先确认：

- `base token`
- `table id/name`
- 字段映射（`title_zh`、`journal`、`published_date`、`domain` 等）

## 4. 通知模板（可选）

当 `notify_enabled=true` 时，`feishu-publisher` 会在文档/表格发布后执行通知命令。

按用户通知（推荐）示例：

```text
lark-cli im +messages-send --as bot --user-id {notify_user_id} --text {notify_text}
```

按群通知示例：

```text
lark-cli im +messages-send --as bot --chat-id {notify_chat_id} --text {notify_text}
```

推荐优先使用群通知。若报错 `Bot/User can NOT be out of the chat`，说明机器人尚未加入该群。

## 5. 自动消息通知（可选）

开启方式（`config.json -> feishu`）：

- `notify_enabled: true`
- `notify_chat_id: "oc_xxx"`（推荐群聊）或配置 `notify_user_id`
- `notify_cmd` 例如：

```text
lark-cli im +messages-send --as bot --user-id {notify_user_id} --text {notify_text}
```

默认通知文案可通过 `notify_message_template` 调整，支持：

- `{title}`
- `{doc_url}`
- `{markdown_file}`
- `{records_file}`
- `{papers_file}`

如需批量通知，使用 `notify_user_ids` 数组，系统会逐个发送。

可选维护字段：`notify_user_notes`（`open_id -> 备注`），仅用于人工可读管理，不参与命令执行。
