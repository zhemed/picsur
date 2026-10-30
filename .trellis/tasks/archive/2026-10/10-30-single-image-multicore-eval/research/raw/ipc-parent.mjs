import { fork } from 'child_process';
import fs from 'fs';
const input = fs.readFileSync('/bench/fixtures/24mp.jpg');
const replyBytes = fs.statSync('/bench/fixtures/24mp.jpg').size ? 94111421 : 0;
const child = fork('/bench/ipc-child.mjs', [], { serialization: 'advanced' });
await new Promise((r) => child.once('message', (m) => m.type === 'ready' && r()));
const rows = [];
for (let i = 0; i < 3; i++) {
  const c0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  const msg = await new Promise((resolve) => {
    child.once('message', resolve);
    child.send({ binary: input, replyBytes });
  });
  const t1 = process.hrtime.bigint();
  const c1 = process.cpuUsage(c0);
  rows.push({
    roundtrip_wall_ms: +(Number(t1 - t0) / 1e6).toFixed(1),
    parent_cpu_ms: +((c1.user + c1.system) / 1000).toFixed(1),
    child_handle_wall_ms: +msg.childHandleWallMs.toFixed(1),
    child_handle_cpu_ms: +msg.childCpuMs.toFixed(1),
    sent_bytes: input.length,
    received_bytes: msg.binary.length,
  });
}
console.log(JSON.stringify({ inputBytes: input.length, replyBytes, rows }, null, 2));
child.kill();
