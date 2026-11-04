"""Offline CPU-only Kokoro bridge. All models must already exist on disk."""
import argparse
import json
import os
from pathlib import Path
import sys
import time

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

# Chinese female voices in the official kokoro-multi-lang-v1_1 bundle.
VOICES = {f"zf_{n:03d}": n + 2 for n in range(1, 9)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--deny-network", action="store_true", help="Offline verification")
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding="utf-8-sig"))
    text = str(request.get("text", "")).strip()
    voice = request.get("voice", "zf_001")
    if not text or len(text) > 5000:
        raise ValueError("Text must contain 1 to 5000 characters")
    if voice not in VOICES:
        raise ValueError(f"Unknown local voice: {voice}")
    root = Path(request["modelDir"]).resolve(strict=True)
    required = ["model.onnx", "voices.bin", "tokens.txt", "lexicon-zh.txt", "lexicon-us-en.txt"]
    for name in required:
        if not (root / name).is_file():
            raise ValueError(f"Missing local model file: {name}")
    if not (root / "espeak-ng-data").is_dir():
        raise ValueError("Missing espeak-ng-data")
    if args.deny_network:
        import socket

        def blocked(*_args, **_kwargs):
            raise RuntimeError("Network forbidden during offline synthesis")

        socket.socket = blocked
        socket.create_connection = blocked
        socket.getaddrinfo = blocked

    import numpy as np
    import sherpa_onnx
    import soundfile as sf

    start = time.monotonic()
    rules = [str(root / name) for name in ("date-zh.fst", "number-zh.fst", "phone-zh.fst") if (root / name).is_file()]
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=str(root / "model.onnx"),
                voices=str(root / "voices.bin"),
                tokens=str(root / "tokens.txt"),
                data_dir=str(root / "espeak-ng-data"),
                lexicon=f"{root / 'lexicon-us-en.txt'},{root / 'lexicon-zh.txt'}",
            ),
            num_threads=max(1, min(4, int(request.get("threads", 2)))),
            provider="cpu",
        ),
        rule_fsts=",".join(rules),
        max_num_sentences=1,
    )
    if not config.validate():
        raise ValueError("Invalid local Kokoro configuration")
    tts = sherpa_onnx.OfflineTts(config)
    loaded = time.monotonic()
    speed = max(0.5, min(2.0, float(request.get("speed", 1))))
    audio = tts.generate(text=text, sid=VOICES[voice], speed=speed)
    samples = np.asarray(audio.samples, dtype=np.float32)
    if len(samples) == 0 or not np.isfinite(samples).all():
        raise ValueError("Synthesis returned invalid audio")
    rms = float(np.sqrt(np.mean(np.square(samples))))
    if rms < 0.0001:
        raise ValueError("Synthesis returned silent audio")
    volume = max(0, min(100, float(request.get("volume", 100)))) / 100
    if volume == 0:
        raise ValueError("Volume is zero; refusing to send silent audio")
    output = Path(request["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output), np.clip(samples * volume, -1, 1), audio.sample_rate, subtype="PCM_16")
    print(json.dumps({
        "engine": "kokoro", "voice": voice, "provider": "cpu", "sampleRate": audio.sample_rate,
        "duration": len(samples) / audio.sample_rate, "loadSeconds": loaded - start,
        "elapsedSeconds": time.monotonic() - start, "rms": rms,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Kokoro offline synthesis failed: {exc}", file=sys.stderr)
        sys.exit(1)
