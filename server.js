// Logs de errores no manejados para ver cualquier crash en Render
process.on('unhandledRejection', (e) => console.error('[UNHANDLED]', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[UNCAUGHT]', e?.stack || e));

import express from 'express';
import { config } from './env.js';
import waRouter from './wa/router.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Health + root (para checks y no matar el proceso)
app.get('/', (_req, res) =>
  res.json({ ok: true, name: 'WA Bot', env: process.env.NODE_ENV || 'production' })
);
app.get('/health', (_req, res) =>
  res.json({ status: 'healthy', ts: new Date().toISOString() })
);

// Webhook WhatsApp
app.use('/wa', waRouter);

// IMPORTANTE: usar el puerto que Render inyecta y bindear a 0.0.0.0
const PORT = Number(process.env.PORT) || Number(config.PORT) || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] WA Bot listening on :${PORT} (TZ=${config.TIMEZONE || 'UTC'})`);
  if (config.DEBUG_LOGS) console.log('[BOOT] DEBUG_LOGS enabled');
  if (!config.WHATSAPP_TOKEN) console.warn('[WARN] WHATSAPP_TOKEN is not set. Outbound messages will fail.');
});
