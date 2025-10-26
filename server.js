// Handlers para ver por logs cualquier crash
process.on('unhandledRejection', (e) => console.error('[UNHANDLED]', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[UNCAUGHT]', e?.stack || e));

import express from 'express';
import { config } from './env.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

let startupError = null;

// Montaje LAZY del router para capturar fallos de import sin tumbar el proceso
(async () => {
  try {
    const waRouter = (await import('./wa/router.js')).default;
    app.use('/wa', waRouter);
    console.log('[BOOT] /wa router mounted');
  } catch (err) {
    startupError = err;
    console.error('[BOOT] Failed to mount /wa router:', err?.stack || err);
  }
})();

// Health siempre vivo (así Render no mata el servicio)
app.get('/', (_req, res) => res.json({
  ok: !startupError,
  name: 'WA Bot',
  env: process.env.NODE_ENV || 'production',
  error: startupError ? String(startupError) : undefined
}));
app.get('/health', (_req, res) => {
  if (startupError) return res.status(500).json({ status: 'degraded', error: String(startupError) });
  return res.json({ status: 'healthy', ts: new Date().toISOString() });
});
app.get('/startup-error', (_req, res) => {
  if (!startupError) return res.json({ ok: true, msg: 'no startup error' });
  res.status(500).send(`<pre>${startupError.stack || startupError}</pre>`);
});

// *** IMPORTANTE: usar el puerto de Render y bindear a 0.0.0.0 ***
const PORT = Number(process.env.PORT) || Number(config.PORT) || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] WA Bot listening on :${PORT} (TZ=${config.TIMEZONE || 'UTC'})`);
  if (config.DEBUG_LOGS) console.log('[BOOT] DEBUG_LOGS enabled');
  if (!config.WHATSAPP_TOKEN) console.warn('[WARN] WHATSAPP_TOKEN is not set. Outbound messages will fail.');
});
