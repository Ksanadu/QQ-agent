# 桌面图标与动态侧栏（0.4.4）

点击桌面左上角的 Q 图标可收起或展开侧栏。收起时保留导航图标、连接状态和退出入口；悬停导航可查看名称。收展不切换或重建当前业务页面，状态仅保存在本机桌面偏好中，不写入机器人配置。

## 图标资源

用户从内置 Imagegen 生成的四款方案中选择了 D，并要求转换为 SVG。最终文件按所选图形重建为可编辑的路径与圆角矩形，外部透明，无嵌入位图或杂点蒙版。

- `desktop/assets/icon.svg`：唯一矢量源，1280×1280 画板；象牙白底、深橄榄色 Q 环、黄绿色消息箭头和星芒。
- `desktop/assets/icon.png`：512×512 透明 PNG。
- `desktop/assets/icon.ico`：16、24、32、48、64、128、256 像素的 Windows 图标。

修改 SVG 后执行：

```sh
npm run build:desktop-icon
npm run test:desktop-ui
npm run build:desktop-ui
npm run test:desktop-package
```

转换脚本复用已安装的 electron-builder 图标工具链。窗口、托盘、安装器和卸载器使用独立桌面的 ICO；侧栏按钮及页面图标使用 SVG。原 `assets/` 和 Web 图标保持原有用途。

## 侧栏行为

- 展开宽度 224 像素，小窗口为 190 像素；收起宽度 62 像素。
- 收展宽度过渡 320 毫秒，文字淡出 180 毫秒。图标槽位固定，当前面板保留。
- 按钮提供“收起侧栏 / 展开侧栏”标签、`aria-expanded` 状态及键盘焦点。
- 通过 `/desktop/api/preferences` 保存 `railCollapsed`，连续点击串行保存，避免较早请求覆盖最新状态；启动时读取该状态。旧版本偏好没有该字段时默认展开。
- 遵循 `prefers-reduced-motion`，关闭装饰动画和收展过渡。

## 本次验证

`test:desktop-ui` 已通过：侧栏恢复、即时反馈、连续收展的保存顺序、退出前等待保存、面板节点不重建、机器人配置不变，以及现有页面、设置、连接与生命周期检查。

`test:desktop-package` 已通过：40 个打包资源与源码匹配，SVG 为纯矢量，ICO 尺寸完整，安装包没有携带机器人内核、配置、聊天数据、扩展或 Node 依赖。

安装包：`dist-desktop/QQ-Agent-Desktop-0.4.4-Setup.exe`，Windows x64，未签名。

已在用户安装的 `D:/QQAgentDesktop/QQ Agent Desktop/` 版本实机验收：标题栏与左上角图标正常；侧栏收展过渡及 62 像素紧凑布局正常；提示随状态切换，空格键可展开；收起后偏好落盘，刷新界面后恢复收起状态。收展期间选中会话与详情保持不变。验收结束时恢复展开，桌面保持运行、连接原 3210 后台，QQ 在线。安装版 ASAR 的 40 个资源已再次与源码核对通过。

## 选中方案的生成记录

概念图使用内置 Imagegen 生成，未使用 CLI/API 备用模式。最终 SVG 是按用户明确要求进行的本地矢量重建，程序不依赖生成图片的临时路径。

所选 D 方案的原始提示词：

> Use case: logo-brand. Create one finished Windows desktop app icon for QQ-Agent, an independent local AI chat agent. Direction D: a single striking Q-shaped orbital ring with its lower-right tail becoming a forward-pointing message arrow, one small four-point intelligence glint cut into the ring as negative space. Premium geometric monogram, sculptural but entirely flat, elegant rather than generic chatbot. Warm ivory rounded-square tile (#f3f3ed), dark olive-charcoal ring (#23251f), a restrained acid-lime accent (#d6e452). Strong silhouette, generous padding, crisp readable geometry at 32px. No other lettering, no long text, no watermark, no gradients, no device mockup, no shadows. One icon only, high-resolution square image, genuinely transparent outside the rounded tile.
