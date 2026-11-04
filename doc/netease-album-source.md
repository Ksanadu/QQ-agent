# 网易云专辑卡片来源修复

已安装的 `netease-music` 扩展原来用 `music` 段的 `type: custom` 发送专辑。现用签名服务会为这种卡片生成 QQ音乐的来源名称、图标及 App ID，尽管跳转目标是网易云专辑。

改为 `type: 163`，保留专辑标题、歌手、封面、专辑链接及首曲试听地址，不传 `id`。当前 SnowLuma 会把它识别为自定义信息，透传给签名服务，生成网易云音乐来源（App ID `100495085`）。单曲 `{ type: '163', id }` 的逻辑不变。

个人扩展目录不进入本仓库。已有该扩展的安装使用以下命令，默认仅预览，`--apply` 才写入并备份原文件；重复执行无变化。请在空闲时应用，让技能热重载完成。

```powershell
node scripts/migrate-netease-album-source.mjs --root="D:/Workplace/QQ-agent"
node scripts/migrate-netease-album-source.mjs --root="D:/Workplace/QQ-agent" --apply
```

迁移只支持已核对的卡片代码形态；未安装或代码不同会报错，不会猜测修改。依赖当前 SnowLuma 对无 ID 自定义字段的支持，以及现用音乐签名服务的行为。

验收：调用实际分享工具构造张悬《神的游戏》专辑卡片，检查签名返回的名称、图标、App ID、标题、封面及跳转链接；私聊发送一张后回读卡片，来源为网易云音乐，用户已确认客户端角标正确。未修改单曲、推荐策略和账号配置。
