"""Underdog Bark 3.0 (ONNX q8) over the shootout corpus; same output as asr-shootout.mjs.
   venv/bin/python -I bench/asr-bark.py <bench dir> [name]
Uses the export's own reference frontend and greedy TDT loop (models/bark/export/tdt.py)."""
import importlib.util, json, os, sys, time
import numpy as np
import onnxruntime as ort
import soundfile as sf

BENCH = sys.argv[1]
NAME = sys.argv[2] if len(sys.argv) > 2 else "bark-3.0"
M = os.path.join(BENCH, "models", "bark")
spec = importlib.util.spec_from_file_location("tdt", os.path.join(M, "export", "tdt.py"))
tdt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tdt)

pp = json.load(open(os.path.join(M, "preprocessor_config.json")))
gen = json.load(open(os.path.join(M, "config.json")))
gen["eos_token_id"] = json.load(open(os.path.join(M, "generation_config.json")))["eos_token_id"]
filters = np.load(os.path.join(M, "fixture", "mel_filters.npy")).astype(np.float32)
vocab = json.load(open(os.path.join(M, "tokenizer.json")))["model"]["vocab"]
pieces = [""] * (max(vocab.values()) + 1)
for p, i in vocab.items():
    pieces[i] = p

so = ort.SessionOptions()
so.intra_op_num_threads = 4  # what the bot uses
enc = ort.InferenceSession(os.path.join(M, "onnx", "encoder_model_quantized.onnx"), so, providers=["CPUExecutionProvider"])
dj = ort.InferenceSession(os.path.join(M, "onnx", "decoder_joint_model_quantized.onnx"), so, providers=["CPUExecutionProvider"])
enc_in = [i.name for i in enc.get_inputs()]


def transcribe(wave):
    feats, mask = tdt.mel(tdt.lead(wave, pp), pp, filters)
    feed = {"input_features": feats}
    if "attention_mask" in enc_in:
        feed["attention_mask"] = mask
    out = enc.run(None, feed)
    e = out[0]
    n = int(out[1].reshape(-1)[0]) if len(out) > 1 else e.shape[1]
    toks, _ = tdt.greedy_tdt(dj, e, n, gen)
    return tdt.detokenize(toks, pieces, gen["blank_token_id"])


if NAME == "check":
    w, sr = sf.read(os.path.join(M, "fixture", "audio.flac"), dtype="float32")
    print(repr(transcribe(w)))
    exp = json.load(open(os.path.join(M, "fixture", "expected.json")))
    print({k: (v if not isinstance(v, list) else len(v)) for k, v in exp.items()})
    sys.exit()

refs = [json.loads(l) for l in open(os.path.join(BENCH, "corpus", "refs.jsonl")) if l.strip()]
os.makedirs(os.path.join(BENCH, "results"), exist_ok=True)
out_path = os.path.join(BENCH, "results", NAME + ".jsonl")
done = set()
if os.path.exists(out_path):
    done = {json.loads(l)["id"] for l in open(out_path) if l.strip()}
k = 0
with open(out_path, "a") as out:
    for r in refs:
        if r["id"] in done:
            continue
        w, sr = sf.read(os.path.join(BENCH, "corpus", r["file"]), dtype="float32")
        t0 = time.perf_counter()
        try:
            hyp = transcribe(w)
        except Exception as e:  # keep going; scored as a miss
            hyp = "<<error %s>>" % e
        out.write(json.dumps({"id": r["id"], "hyp": hyp.strip(), "ms": round((time.perf_counter() - t0) * 1000)}) + "\n")
        out.flush()
        k += 1
        if k % 50 == 0:
            print(NAME, k, flush=True)
print(NAME, "done", k)
