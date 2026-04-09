# 飞书命令模板（模块专属参数）

本文档只保留 `feishu.*` 模块参数与命令模板占位符。通用部署、认证、故障处理请统一参考根目录 `README.md`。

## 可用占位符
- `{title}`：文档标题（已完成 shell 安全转义）
- `{markdown_file}`：日报 Markdown 文件路径
- `{records_file}`：多维表格记录 JSON 文件路径
- `{papers_file}`：增强后的完整论文 JSON 路径
- `{notify_chat_id}`：通知群 `chat_id`
- `{notify_user_id}`：通知用户 `user_id`
- `{doc_url}`：文档发布后自动提取到的链接
- `{notify_text}`：由 `notify_message_template` 渲染后的通知文案

## 文档发布模板

```text
lark-cli docs +create --as bot --title {title} --markdown "$(cat {markdown_file})"
```

## 通知模板

```text
# 按用户
lark-cli im +messages-send --as bot --user-id {notify_user_id} --text {notify_text}

# 按群
lark-cli im +messages-send --as bot --chat-id {notify_chat_id} --text {notify_text}
```

## 告警模板（papers=0 或流程失败）

```text
feishu.alert_enabled=true
feishu.alert_cmd=lark-cli im +messages-send --as bot --chat-id {notify_chat_id} --text {notify_text}
feishu.alert_chat_id=oc_xxx
```

## Base 推送参数提示
- `base_enabled`：是否启用多维表格推送。
- `base_publish_cmd`：按表结构自定义命令模板。
- 建议先完成 dry-run，再逐步映射 `title_zh/journal/published_date/domain` 等字段。
