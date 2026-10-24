"""IBM Granite Speech 5.0 470M TurboCTC over the shootout corpus (torch fp32 on CPU,
so its speed isn't comparable with the int8 ONNX models). Same output as asr-shootout.mjs.
   venv/bin/python -I bench/asr-granite.py <bench dir> [threads]"""
import json, os, sys, time
import soundfile as sf
import torch
from transformers import AutoModelForCTC, AutoProcessor

BENCH = sys.argv[1]
torch.set_num_threads(int(sys.argv[2]) if len(sys.argv) > 2 else 4)
MID = "ibm-granite/granite-speech-5.0-470m-turboctc"
proc = AutoProcessor.from_pretrained(MID)
model = AutoModelForCTC.from_pretrained(MID).eval()
rate = proc.feature_extractor.sampling_rate


def transcribe(w):
    inputs = proc([w], sampling_rate=rate)
    with torch.inference_mode():
        out = model.generate(**inputs)
    return proc.batch_decode(out, skip_special_tokens=True)[0]


refs = [json.loads(l) for l in open(os.path.join(BENCH, "corpus", "refs.jsonl")) if l.strip()]
out_path = os.path.join(BENCH, "results", "granite-470m.jsonl")
done = set()
if os.path.exists(out_path):
    done = {json.loads(l)["id"] for l in open(out_path) if l.strip()}
transcribe(sf.read(os.path.join(BENCH, "corpus", refs[0]["file"]), dtype="float32")[0])  # warm up
k = 0
with open(out_path, "a") as out:
    for r in refs:
        if r["id"] in done:
            continue
        w, _ = sf.read(os.path.join(BENCH, "corpus", r["file"]), dtype="float32")
        t0 = time.perf_counter()
        try:
            hyp = transcribe(w)
        except Exception as e:
            hyp = "<<error %s>>" % e
        out.write(json.dumps({"id": r["id"], "hyp": hyp.strip(), "ms": round((time.perf_counter() - t0) * 1000)}) + "\n")
        out.flush()
        k += 1
        if k % 50 == 0:
            print("granite", k, flush=True)
print("granite done", k)
