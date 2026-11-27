import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer | undefined;

export default async function globalSetup() {
  process.env.AEROPULSE_VISUAL_TEST = '1';
  server = await createServer({
    configFile: './vite.config.ts',
    server: { host: '127.0.0.1', port: 4173, strictPort: true },
  });
  await server.listen();
  return async () => {
    await server?.close();
    server = undefined;
  };
}
