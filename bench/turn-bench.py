"""End-of-turn test: Smart Turn v3.2 versus the fixed silence wait PC rooms use now (0.8 s).

Each clip is one utterance. Silero finds the pauses inside it; at every pause the person
was NOT done (truth "incomplete"), at the end they were (truth "complete").
  fixed X s:   a pause of X s or more inside the clip cuts them off; the end costs X s of waiting.
  smart:       after `stop` s of silence the model is asked with the audio so far. "complete"
               ends the turn (inside the clip that's a cut-off); "incomplete" keeps waiting until
               `fallback` s. The end costs `stop` s if the model says complete, else `fallback` s.
Sets: the shootout corpus (pc TTS, AMI far/headset, LibriSpeech), Rique's recordings (real),
and longer AMI headset segments (ami-long, fetched once) because they have real hesitations.
   venv/bin/python -I bench/turn-bench.py <bench dir> <smart-turn.onnx> <silero_vad.onnx>"""
import io, json, os, sys, time, urllib.request
import numpy as np
import onnxruntime as ort
import soundfile as sf
from transformers import WhisperFeatureExtractor

BENCH, ST_PATH, VAD_PATH = sys.argv[1:4]
RATE, FRAME = 16000, 512  # silero frame: 32 ms
STOP, FALLBACK = 0.2, 2.0


def session(p):
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return ort.InferenceSession(p, so, providers=["CPUExecutionProvider"])


st = session(ST_PATH)
vad = session(VAD_PATH)
fe = WhisperFeatureExtractor(chunk_length=8)


def turn_prob(audio):
    """Smart Turn's own preprocessing (pipecat-ai/smart-turn inference.py)."""
    a = audio[-8 * RATE:]
    if len(a) < 8 * RATE:
        a = np.pad(a, (8 * RATE - len(a), 0))
    f = fe(a, sampling_rate=RATE, return_tensors="np", padding="max_length", max_length=8 * RATE, truncation=True, do_normalize=True)
    return float(st.run(None, {"input_features": f.input_features.astype(np.float32)})[0].reshape(-1)[0])


def speech_frames(audio):
    h = np.zeros((2, 1, 64), np.float32)
    c = np.zeros((2, 1, 64), np.float32)
    out = []
    for i in range(0, len(audio) - FRAME + 1, FRAME):
        p, h, c = vad.run(None, {"x": audio[i:i + FRAME][None].astype(np.float32), "h": h, "c": c})
        out.append(float(p.reshape(-1)[0]) > 0.5)
    return out


def pauses(audio):
    """(start sample, length s) of each silence between the first and last speech frame."""
    sp = speech_frames(audio)
    idx = [i for i, s in enumerate(sp) if s]
    if not idx:
        return [], None
    first, last = idx[0], idx[-1]
    res, run = [], None
    for i in range(first, last + 1):
        if not sp[i]:
            run = i if run is None else run
        elif run is not None:
            res.append((run * FRAME, (i - run) * FRAME / RATE))
            run = None
    return res, (last + 1) * FRAME


def clips():
    for l in open(os.path.join(BENCH, "corpus", "refs.jsonl")):
        r = json.loads(l)
        yield r["set"], sf.read(os.path.join(BENCH, "corpus", r["file"]), dtype="float32")[0]
    for root, _, files in os.walk(os.path.join(BENCH, "real-raw")):
        for f in sorted(files):
            if f.endswith(".wav"):
                yield "real", sf.read(os.path.join(root, f), dtype="float32")[0]
    d = os.path.join(BENCH, "corpus", "ami-long")
    if not os.path.isdir(d):
        os.makedirs(d)
        got, off = 0, 0
        while got < 80 and off < 4000:
            url = "https://datasets-server.huggingface.co/rows?dataset=edinburghcstr/ami&config=ihm&split=test&offset=%d&length=100" % off
            rows = json.load(urllib.request.urlopen(url, timeout=60))["rows"]
            off += 100
            for row in rows:
                row = row["row"]
                if len(row["text"].split()) < 18:
                    continue
                src = row["audio"][0]["src"] if isinstance(row["audio"], list) else row["audio"]["src"]
                a, sr = sf.read(io.BytesIO(urllib.request.urlopen(src, timeout=60).read()), dtype="float32")
                if a.ndim > 1:
                    a = a.mean(1)
                if sr != RATE:
                    continue
                sf.write(os.path.join(d, "%03d.wav" % got), a, RATE, subtype="PCM_16")
                got += 1
                if got >= 80:
                    break
    for f in sorted(os.listdir(d)):
        yield "ami-long", sf.read(os.path.join(d, f), dtype="float32")[0]


stats = {}
lat = []
for name, audio in clips():
    ps, end = pauses(audio)
    if end is None:
        continue
    s = stats.setdefault(name, {"clips": 0, "pauses": 0, "fixed_cut": 0, "fixed05_cut": 0, "smart_cut": 0, "smart_wrong_pauses": 0, "end_ok": 0, "smart_wait": 0.0, "hybrid_cut": 0, "hybrid_wait": 0.0, "examples": []})
    s["clips"] += 1
    fixed_cut = fixed05 = smart_cut = hybrid_cut = False
    for start, length in ps:
        if length < STOP:
            continue
        s["pauses"] += 1
        fixed_cut |= length >= 0.8
        fixed05 |= length >= 0.5
        t0 = time.perf_counter()
        p = turn_prob(np.concatenate([audio[:start], np.zeros(int(STOP * RATE), np.float32)]))
        lat.append((time.perf_counter() - t0) * 1000)
        if p > 0.5 or length >= FALLBACK:
            s["smart_wrong_pauses"] += 1
            smart_cut = True
        # hybrid: the 0.8 s wait stays, but "not done yet" there extends it to the fallback
        if length >= 0.8:
            p8 = p if abs(0.8 - STOP) < 1e-9 else turn_prob(np.concatenate([audio[:start], np.zeros(int(0.8 * RATE), np.float32)]))
            hybrid_cut |= p8 > 0.5 or length >= FALLBACK
    s["fixed_cut"] += fixed_cut
    s["fixed05_cut"] += fixed05
    s["smart_cut"] += smart_cut
    s["hybrid_cut"] += hybrid_cut
    pe8 = turn_prob(np.concatenate([audio[:end], np.zeros(int(0.8 * RATE), np.float32)]))
    s["hybrid_wait"] += 0.8 if pe8 > 0.5 else FALLBACK
    pe = turn_prob(np.concatenate([audio[:end], np.zeros(int(STOP * RATE), np.float32)]))
    s["end_ok"] += pe > 0.5
    s["smart_wait"] += STOP if pe > 0.5 else FALLBACK

print("set        clips pauses | cut at 0.8s  cut at 0.5s  smart cut | ends seen as done  smart wait | hybrid cut  hybrid wait")
tot = {}
for k, s in stats.items():
    for kk in ("clips", "pauses", "fixed_cut", "fixed05_cut", "smart_cut", "end_ok", "smart_wait", "hybrid_cut", "hybrid_wait"):
        tot[kk] = tot.get(kk, 0) + s[kk]
for k, s in list(stats.items()) + [("ALL", tot)]:
    n = s["clips"]
    print("%-10s %5d %6d | %5.1f%%       %5.1f%%       %5.1f%%   | %5.1f%%             %.2f s     | %5.1f%%     %.2f s" % (
        k, n, s["pauses"], 100 * s["fixed_cut"] / n, 100 * s["fixed05_cut"] / n, 100 * s["smart_cut"] / n, 100 * s["end_ok"] / n, s["smart_wait"] / n,
        100 * s["hybrid_cut"] / n, s["hybrid_wait"] / n))
lat.sort()
print("smart turn latency (1 thread): p50 %.1f ms, p90 %.1f ms, n %d" % (lat[len(lat) // 2], lat[int(len(lat) * 0.9)], len(lat)))
