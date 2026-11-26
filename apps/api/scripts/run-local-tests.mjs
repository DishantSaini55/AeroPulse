import net from 'node:net';
import { spawn } from 'node:child_process';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://aeropulse_test:aeropulse_test@127.0.0.1:55432/aeropulse_test?schema=public';
const parsed = new URL(databaseUrl);
const port = Number(parsed.port || 5432);
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: environment, shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)));
  });
}

function verifyConnection() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: parsed.hostname, port });
    socket.setTimeout(5_000);
    socket.once('connect', () => { socket.end(); resolve(); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`Timed out connecting to isolated test PostgreSQL at ${parsed.hostname}:${port}`)); });
    socket.once('error', error => reject(new Error(`Cannot connect to isolated test PostgreSQL at ${parsed.hostname}:${port}. Start it with: docker compose -f ../../docker-compose.test.yml up -d --wait (${error.message})`)));
  });
}

try {
  await verifyConnection();
  const environment = { ...process.env, DATABASE_URL: databaseUrl };
  await run(executable, ['prisma', 'migrate', 'deploy'], environment);
  await run(executable, ['prisma', 'db', 'seed'], environment);
  await run(npm, ['run', 'test:ci'], environment);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
