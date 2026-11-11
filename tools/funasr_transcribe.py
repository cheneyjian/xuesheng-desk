#!/usr/bin/env python3
"""把录音转成带时间戳的文字稿（FunASR，本地离线）。

输入：--audio 录音文件（webm 等，需要本机装有 ffmpeg）
输出：--out JSON，格式 {"segments": [{"start": 秒, "end": 秒, "text": "..."}]}

依赖：
    brew install ffmpeg
    pip install funasr modelscope torch torchaudio
首次运行会下载模型，需要联网，之后可离线使用。

注意：这个脚本我没有在真实环境里跑过。FunASR 的参数名随版本有变化，
如果报错，把报错贴出来再调整即可。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile


def to_wav(src, dst):
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-ac", "1", "-ar", "16000", dst],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="paraformer-zh")
    args = parser.parse_args()

    try:
        from funasr import AutoModel
    except ImportError:
        sys.exit("缺少 funasr：请先运行 pip install funasr modelscope torch torchaudio")

    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "audio.wav")
        try:
            to_wav(args.audio, wav)
        except FileNotFoundError:
            sys.exit("找不到 ffmpeg：请先运行 brew install ffmpeg")
        except subprocess.CalledProcessError as err:
            sys.exit("ffmpeg 转码失败：" + err.stderr.decode("utf-8", "ignore")[-300:])

        model = AutoModel(model=args.model, vad_model="fsmn-vad", punc_model="ct-punc")
        results = model.generate(input=wav, batch_size_s=300, sentence_timestamp=True)

    segments = []
    for item in results:
        sentences = item.get("sentence_info")
        if sentences:
            for s in sentences:
                segments.append(
                    {"start": s["start"] / 1000.0, "end": s["end"] / 1000.0, "text": s["text"]}
                )
        elif item.get("text"):
            # 引擎没给分句时间戳：整段作为一句，时间戳留空
            segments.append({"start": 0.0, "end": 0.0, "text": item["text"]})

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"segments": segments}, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
