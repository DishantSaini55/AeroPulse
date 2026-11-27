// Loaded only by the loopback benchmark process, never the normal API runtime.
setInterval(() => {
  const cpu = process.cpuUsage();
  process.stdout.write(`BENCH_PROCESS_METRIC ${JSON.stringify({ cpuMicros: cpu.user + cpu.system, rssBytes: process.memoryUsage().rss })}\n`);
}, 1000).unref();
