---
name: comfy-draw
description: 在本机 QQ-Agent 中仅处理用户直接发送的 /comfy 图片要求，自动整理 Anima tags，先受理再通过本地 ComfyUI 生成并回传一张图片。
---

# ComfyUI 命令生图

本技能由 QQ-Agent 的 `skill.json` 和 `index.js` 装载。入站命令由 `../../src/image-commands.js` 解析；队列和交付流程使用 `../../src/image-command-service.js`。模型只有只读状态工具，没有可隐式调用的生图工具。

- 仅本人真实消息以 `/comfy` 开头才出图，允许 @机器人和回复段；引用正文、转发、历史和普通的“画图/自拍”不触发。
- 先通过 SendQueue 回复受理，再用专用提示词模型（默认 `gemini-3.8-flash-medium`，可通过 `promptModel` 配置）把要求转换成 Anima 所需的小写、下划线、逗号分隔的 danbooru tags 和画幅。聊天模型配置不变。当前 Flash Low 在角色 tags JSON 上已实测反复截断，不作为默认提示词模型。
- 提示词整理使用反代的 JSON schema 输出约束。模型返回半截 JSON 或无效字段时，由核心 `chatCompletionJson` 最多纠正一次，成功后才提交唯一的 GPU 任务；不自行补闭合符号或使用残缺内容。内容拒绝不重试、不提交 GPU，并明确回复拒绝；格式故障单独说明原因。
- 每个命令只生成一张；工作流的 latent batch_size 固定为 1，只读取最终保存节点 78。保留现有模板、默认质量词、负面词、MP、画幅与 seed 逻辑。大肥鱼自拍仍使用原有形象 tags 和专用 LoRA。
- 本地通道没有 QQ 日额度或小时限频；GPU 任务在独立队列中串行处理。`/generate` 的 Gemini API 每日 3 张额度与本技能无关。
- 本技能保留原有全年龄、着装、非性化规则；不通过改写绕过，不自动重画或重试 GPU 生成。
- 请求去重记录保存到 `data/comfy-draw/requests.json`，成品和元数据保存在同目录。图片先下载至本机缓存，再通过 SendQueue 发原会话，引用/@对应请求者。
- 停用、应用停止或会话权限改变后不再返图；只删除本任务的待执行 GPU 队列项，绝不调用全局 interrupt 清掉别人任务。

示例：`/comfy 一只在月球上喝茶的橘猫，动漫插画，竖版`。

没有命令时只说明 `/comfy` 和 `/generate` 的用法，不替用户选择后端。
