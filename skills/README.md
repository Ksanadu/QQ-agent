# 随仓库发布的技能

以下技能包含源码、清单及按需速查，可由 QQ-Agent 的技能加载器直接装载。运行开关和个人配置保存在本机 `data/config.json` 的 `skills` 字段，不随仓库发布。关闭技能不会删除其运行数据。

| 目录 | 功能 | 外部依赖 |
| --- | --- | --- |
| antigravity-image | `/generate` 文字/参考图生成，先受理后返图 | 本机 Antigravity、可用图片模型；密钥从本机配置读取 |
| bangumi-lookup | 番剧、角色、人物与放送查询 | Bangumi API 网络连接 |
| bilibili | 视频、搜索、UP主、热榜；查梗先查站内视频简介与评论 | 独立安装 bili CLI；路径可配置 |
| comfy-draw | `/comfy` 本地生成，独立队列 | ComfyUI、兼容 Anima API 工作流和模型 |
| cross-group-memory | 群友记忆记录、查询与整理 | 记忆仅保存到本机数据目录；整理使用已配置模型 |
| netease-music | 曲库推荐、查询及网易云来源的歌曲/专辑卡片 | 独立 cloud-music-mcp Python 环境和本机登录态 |
| sticker-librarian | 表情库盘点与管理 | QQ 协议端；删除仍经过宿主授权机制 |
| tts-say | 普通话/粤语本地 CPU 语音合成 | sherpa-onnx、soundfile 和另行下载的模型；见技能 README |

这些源码不包含 API 密钥、访问令牌、Cookie、账号配置、群友记忆、聊天记录、收藏曲库、生成媒体、模型权重或个人 ComfyUI 工作流。新装环境仍需完成依赖配置；清单中的默认启用不代表外部服务已就绪。请勿将运行数据存入技能源码目录。

## 音乐技能

默认在 QQ-Agent 项目同级的 `cloud-music-mcp` 目录寻找 `.venv` 与 `src/cloud_music_mcp`，也可设置环境变量 `CLOUD_MUSIC_MCP_ROOT`。`pythonPath` 可覆盖解释器，`scriptPath` 可覆盖本技能自带的 `scripts/netease-cli.py`。登录由操作员在本机独立完成，不上传 Cookie；登录辅助命令未暴露给聊天模型。

专辑分享使用网易云类型和自定义专辑字段，不传歌曲 ID；标题、封面和专辑链接保持原样，来源名称与图标为网易云音乐。

## ComfyUI

设置 `workflowFile` 指向本机 API 格式 JSON；留空读取 `data/comfy-draw/workflow.json`。当前实现按固定节点编号接入 Anima 模板，需要节点 `5/69/71/118/87/68/78`，自拍预设另需对应模型、CLIP、LoRA 节点和权重。此仓库不分发私人工作流及模型，任意 ComfyUI 工作流不能直接替换。

## 维护

`.gitignore` 仅允许上述已审阅目录入库，仍排除技能内常见配置、凭据、缓存和权重文件。发布前应检查待提交文件，忽略规则不能代替人工脱敏。历史专辑迁移脚本仅供升级旧扩展使用；当前仓库内的音乐技能已包含该修复。
