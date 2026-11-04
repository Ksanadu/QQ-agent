# 本地语音回复

默认按聊天文字自动选择普通话 Kokoro multi-lang v1.1（zf_001）或粤语 VITS Cantonese（xiaomaiiwn），通过 sherpa-onnx 在 CPU 上运行。
这是开源模型音色，不是微软原版 XiaoyiNeural。运行期间不访问 Edge、Azure 或其他在线合成服务。

## 运行环境

- `data/tts-neural/.venv/Scripts/python.exe`：独立 Python 环境。
- `data/tts-neural/kokoro-multi-lang-v1_1/`：模型、音色、词典和文本归一化规则。
- `data/tts-neural/vits-cantonese-hf-xiaomaiiwn/`：粤语 ONNX 模型、lexicon.txt、tokens.txt、rule.fst。
- Python 依赖见部署记录；测试环境使用 sherpa-onnx 1.13.8、soundfile 0.14.0。
- 模型来源：https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html
- 粤语来源：https://huggingface.co/csukuangfj/vits-cantonese-hf-xiaomaiiwn ，固定版本 `27e0da148bbe6c120107c0d6d01c218337f803e8`。
- 粤语模型 SHA256：`7d8d4f5550b607999417a99131b034c8cc2b8dca69f9e9fdefeff6655643c139`。
- 首次安装需要下载模型；日常合成只读取本地文件。

## 设置

- `engine=kokoro`：本地双语神经语音。普通话 `neuralVoice` 可选 `zf_001` 到 `zf_008`，默认 `zf_001`；粤语走独立的 VITS 模型，不是 Kokoro 粤语音色，两种声音不同。
- `languageMode=auto`：工具 `say`、`say_to` 都支持自动判断，也可传 `language=zh/yue`。优先级为工具明确指定 → 设置固定语言 → 本轮明确要求 → 朗读文字含粤语特征 → 本轮请求的粤语特征 → 普通话。不跨会话记住语言。
- 只看本轮相关语音请求的正文，排除已读历史、昵称、引用前缀、核心提示和技能注入；要求回答时提示模型用相应语言组织答案，要求朗读时保留原文。
- `唔、冇、嘅、喺、佢、咗、啲、點解、我係` 等字词会触发粤语；繁体字本身不触发。普通话和粤语共用、无法仅从文字判断的句子（如“你好”）默认普通话，可写“用粤语说你好”。
- `cantoneseModelDir`：留空使用上述粤语模型目录。粤语和普通话共用独立 Python 环境、CPU 线程限制及串行合成队列。
- `neuralThreads=2`：CPU 线程，范围 1 到 4，不占 GPU 显存。并发请求按顺序合成。
- `neuralPython`、`neuralModelDir`：留空使用上述默认目录，允许指定其他本地绝对路径。
- `engine=sapi`：手动选择 Windows 系统语音，使用 `voice` 设置。
- 神经语音异常时明确报错并允许文字回复，不会悄悄切回机械音或在线服务。
- 语速、音量、字数/估算时长上限、冷却、演练模式与跨会话设置沿用原逻辑。

用户明确要求发语音或朗读时才调用 `say`。此功能判断聊天文字，不负责收到的 QQ 语音的语种识别。跨会话 `say_to` 仍受原有开关、目标白名单和黑名单约束。
音频发送和会话交付登记继续使用核心发送器，发送或演练完成后清理临时音频及请求文件。

## 独立验证

`kokoro_synth.py --request request.json --deny-network` 可在禁用 Python 网络接口的情况下合成测试音频。
粤语对应 `cantonese_synth.py --request request.json --deny-network`，输出 22050 Hz PCM WAV；普通话输出 24000 Hz。技能实际合成也带 `--deny-network`。
请求字段：`text`、`voice`、`modelDir`、`output`，可选 `threads`、`speed`、`volume`。
