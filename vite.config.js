import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Local dev proxy — mirrors api/pipedrive.js (the Vercel serverless function)
 * so `npm run dev` works without the Vercel CLI. Token stays in Node, never
 * reaches the browser.
 */
function pipedriveProxy(token) {
  return {
    name: 'pipedrive-proxy',
    configureServer(server) {
      server.middlewares.use('/api/pipedrive', async (req, res) => {
        const send = (code, payload) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json');
          res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
        };

        if (!token) return send(500, { error: 'PIPEDRIVE_API_TOKEN missing from .env' });

        const params = new URL(req.url, 'http://local').searchParams;
        const path = params.get('path');
        params.delete('path');
        if (!path || !/^\/api\/v[12]\//.test(path)) return send(400, { error: 'Invalid path' });

        let body = '';
        for await (const chunk of req) body += chunk;

        const qs = params.toString();
        try {
          const r = await fetch(`https://api.pipedrive.com${path}${qs ? `?${qs}` : ''}`, {
            method: req.method,
            headers: { 'Content-Type': 'application/json', 'x-api-token': token },
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : (body || '{}'),
          });
          send(r.status, (await r.text()) || '{}');
        } catch (e) {
          send(502, { error: `Proxy failure: ${e.message}` });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), pipedriveProxy(env.PIPEDRIVE_API_TOKEN)],
    server: { port: 5173, open: true },
  };
});
