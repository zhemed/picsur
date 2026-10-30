// Child: receive one message, measure own cpu for handling, reply with a big buffer.
let handled = 0;
process.on('message', (msg) => {
  const start = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  // emulate worker->parent result payload size (QOI bytes for 24MP ~= 94MB)
  const payload = Buffer.alloc(msg.replyBytes);
  payload[0] = 1;
  const cpu = process.cpuUsage(start);
  const t1 = process.hrtime.bigint();
  handled++;
  process.send({
    receivedBytes: msg.binary.length,
    replyBytes: payload.length,
    childHandleWallMs: Number(t1 - t0) / 1e6,
    childCpuMs: (cpu.user + cpu.system) / 1000,
    seq: handled,
    binary: payload,
  });
});
process.send({ type: 'ready' });
