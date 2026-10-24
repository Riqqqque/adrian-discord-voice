"""Reference probabilities for bench/turn-parity.mjs (pipecat-ai/smart-turn's inference.py preprocessing).
   venv/bin/python -I bench/turn-parity.py <model.onnx> <out.json> <wav>..."""
import json, sys
import numpy as np
import onnxruntime as ort
import soundfile as sf
from transformers import WhisperFeatureExtractor

model, out, wavs = sys.argv[1], sys.argv[2], sys.argv[3:]
so = ort.SessionOptions()
so.intra_op_num_threads = 1
s = ort.InferenceSession(model, so, providers=["CPUExecutionProvider"])
fe = WhisperFeatureExtractor(chunk_length=8)
res = {}
for f in wavs:
    a = sf.read(f, dtype="float32")[0]
    a = np.concatenate([a, np.zeros(12800, np.float32)])[-128000:]
    a = np.pad(a, (128000 - len(a), 0))
    x = fe(a, sampling_rate=16000, return_tensors="np", padding="max_length", max_length=128000, truncation=True, do_normalize=True)
    res[f] = float(s.run(None, {"input_features": x.input_features.astype(np.float32)})[0].reshape(-1)[0])
json.dump(res, open(out, "w"))
print(len(res), "clips")
