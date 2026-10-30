# Antigravity 原生 Google 搜索（2026-10-30）

本机 Antigravity Tools 5.0.0 实测支持 Gemini `googleSearch`。原生 `streamGenerateContent?alt=sse` 返回 `groundingMetadata`，包括实际搜索词、来源和引文对应关系。非流式接口可能在聚合流响应时丢失元数据，因此本功能直接消费原生流式响应，不以模型文本中自行写出的链接作为联网成功凭据。

QQ-Agent 保留现有 `web_search` 工具，选择 `webSearch.provider=antigravity` 后，其内部单独调用原生搜索，再把 `answer`、`results`、`searchQueries` 和 `grounded=true` 返回主模型。主聊天仍使用原来的工具循环；原生搜索请求只携带 `googleSearch`，不混入 `send_message` 等函数工具，避免反代跳过内置搜索的工具混用冲突。

配置 `webSearch.antigravity`：`providerId` 选择已有模型提供商，复用该提供商地址与密钥；`model` 指定支持联网的 Gemini 文本模型；`timeoutMs` 默认 90000，`maxOutputTokens` 默认 2048。管理界面位于搜索服务设置。不会复制或另存 API 密钥，也不会因主聊天改用其他模型就误用其凭据。

搜索返回的摘要由 Gemini 根据 Google 搜索生成，snippet 为引文支持的摘要片段，不等同于独立抓取的页面全文。来源仍需按问题核对。Google 可能返回来源重定向链接，这是原生搜索元数据中的真实 URI。返回的 usage 是搜索子请求自身用量，可在工具记录查看；现有主会话 token 统计未额外合并这部分，不应按它推算全部搜索消耗。

没有真实来源、原生流报错或响应异常时，搜索明确失败，不悄悄回退 Bing。该功能会使用 Antigravity 账号池中的 Gemini 模型额度。仅切换网页搜索；`web_fetch`、图片搜索、回复收尾和任务规划保持原流程。

验收：`npm run test:native-search`。覆盖连接与凭据选择、流分包/UTF-8、引文、无来源拒绝、上游错误，以及模拟 QQ 消息到原生搜索、再通过主会话工具发送的完整链路。实网验收另外检查真实 `webSearchQueries` 与 `groundingChunks`，不向真实 QQ 群发送测试消息。
