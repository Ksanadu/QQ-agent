"""Offline CPU-only VITS Cantonese bridge for sherpa-onnx."""
import argparse
import json
import os
from pathlib import Path
import sys
import time

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--deny-network", action="store_true")
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding="utf-8-sig"))
    text = str(request.get("text", "")).strip()
    if not text or len(text) > 5000:
        raise ValueError("Text must contain 1 to 5000 characters")
    root = Path(request["modelDir"]).resolve(strict=True)
    for name in ("vits-cantonese-hf-xiaomaiiwn.onnx", "lexicon.txt", "tokens.txt", "rule.fst"):
        if not (root / name).is_file():
            raise ValueError(f"Missing local Cantonese model file: {name}")
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
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(root / "vits-cantonese-hf-xiaomaiiwn.onnx"),
                lexicon=str(root / "lexicon.txt"),
                tokens=str(root / "tokens.txt"),
                data_dir="", dict_dir="",
            ),
            num_threads=max(1, min(4, int(request.get("threads", 2)))),
            provider="cpu",
        ),
        rule_fsts=str(root / "rule.fst"),
        max_num_sentences=1,
    )
    if not config.validate():
        raise ValueError("Invalid local Cantonese configuration")
    tts = sherpa_onnx.OfflineTts(config)
    loaded = time.monotonic()
    audio = tts.generate(text=text, sid=0, speed=max(0.5, min(2.0, float(request.get("speed", 1)))))
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
        "engine": "vits-cantonese", "voice": "xiaomaiiwn", "language": "yue", "provider": "cpu",
        "sampleRate": audio.sample_rate, "duration": len(samples) / audio.sample_rate,
        "loadSeconds": loaded - start, "elapsedSeconds": time.monotonic() - start, "rms": rms,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Cantonese offline synthesis failed: {exc}", file=sys.stderr)
        sys.exit(1)
