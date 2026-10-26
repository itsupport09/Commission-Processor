// Serverless proxy — keeps the Pipedrive token off the browser and avoids CORS.
// Deploy on Vercel. Set PIPEDRIVE_API_TOKEN in project env vars.

export default async function handler(req, res) {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) return res.status(500).json({ error: 'PIPEDRIVE_API_TOKEN not set' });

  const { path, ...params } = req.query;
  if (!path || !/^\/api\/v[12]\//.test(path)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const qs = new URLSearchParams(params).toString();
  const url = `https://api.pipedrive.com${path}${qs ? `?${qs}` : ''}`;

  const writing = !['GET', 'HEAD'].includes(req.method);
  const dealWrite = writing && /^\/api\/v[12]\/deals\/(\d+)$/.exec(path);

  try {
    // A deal is only ever updated once it is won. Checked here as well as in the
    // UI, so no caller can write to an open or lost deal.
    if (dealWrite) {
      const dealId = dealWrite[1];
      const probe = await fetch(`https://api.pipedrive.com/api/v2/deals/${dealId}`, {
        headers: { 'x-api-token': token },
      });
      const probeJson = await probe.json().catch(() => ({}));
      const dealStatus = probeJson?.data?.status;
      if (dealStatus !== 'won') {
        return res.status(409).json({
          success: false,
          error: `Deal ${dealId} is ${dealStatus || 'unreadable'} — Pipedrive is only updated on won deals`,
        });
      }
    }

    const r = await fetch(url, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'x-api-token': token },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
    });
    const text = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json').send(text || '{}');
  } catch (e) {
    res.status(502).json({ error: `Proxy failure: ${e.message}` });
  }
}
