// Smart Turn in a child process, for sidetalk-pipeline.ts: on Windows
// onnxruntime-node can't load in a process that already has sherpa-onnx.
// Answers { id, samples } with { id, p, cpuMs }.

import { SmartTurn } from '../speech/smart-turn.js';

const turn = await SmartTurn.loadHere(process.argv[2]!);
const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
process.on('message', (m: { id: number; samples: Float32Array }) => {
  const c0 = cpu();
  turn.complete(m.samples).then(
    (p) => process.send!({ id: m.id, p, cpuMs: cpu() - c0 }),
    (e: Error) => process.send!({ id: m.id, error: e.message }),
  );
});
process.send!({ ready: true });
