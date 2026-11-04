---
name: antigravity-image
description: 在本机 QQ-Agent 中处理用户直接发送的 /generate 图片要求，自动整理 prompt，调用 Gemini Flash Image 并异步回传一张图片。
---

# Antigravity 命令生图

本技能由 QQ-Agent 的 `skill.json` 和 `index.js` 装载，核心入站命令分发见 `../../src/image-commands.js`。无需给模型暴露生图工具；唯一模型工具是只读的队列状态。

- 仅真实 OneBot 入站消息以 `/generate` 开头才受理；允许 @机器人和回复段，不读取被引用的正文、转发、历史或模型提供的 QQ 号。
- 先通过 SendQueue 回复受理，再由当前聊天模型把要求整理成自然语言 prompt 和画幅；原始要求同时保留。提示词整理失败不提交生图。
- 固定请求 `gemini-3.1-flash-image`、`n=1`、1K；模型和张数不接受用户覆盖。没有自动重画或生图请求重试。
- 普通用户跨所有群与私聊，按北京时间自然日每天最多生成 3 张，零点重置；可以连续请求，没有小时或请求间隔限制。管理员 不限张数。相同消息重复投递仍只处理一次。
- 受理时用唯一任务 ID 预留每日额度，原子落盘到 `data/antigravity-image/quota.json`；重启仍有效，文件损坏时拒绝生成而不清零。受理回复、prompt 整理或生图失败会释放对应预留；已得到图片后保存或发送失败仍计入每日张数。跨日结束的旧任务不得影响新一天的预留。
- 本地读取当前用户 `.antigravity_tools/gui_config.json` 获取端口和密钥，只向 127.0.0.1 发送。密钥不写入技能文件、日志、prompt 或图片元数据。
- 成品和请求元数据保存至 `data/antigravity-image/`，通过 SendQueue 发本地文件，必要时回退 base64；停用、暂停、黑名单/白名单变化和停止应用会重新检查或取消待发任务。

用法：`/generate 一只在月球上喝茶的橘猫，电影感，方形构图`。

普通的“帮我画一张”只提示命令用法。`/comfy` 是独立的本地生图通道，不占 API 每日额度，也不经过 API 的队列或限额文件。不得替用户切换后端。两条通道复用 `../../src/image-command-service.js` 的先受理、后台生成、返图及取消逻辑。
