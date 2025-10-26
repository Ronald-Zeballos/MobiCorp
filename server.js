// Trampas para ver cualquier crash en logs de Render
process.on('unhandledRejection', (e) => console.error('[UNHANDLED]', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[UNCAUGHT]', e?.stack || e));

import express from 'express';
import { config } from './env.js';
import * as WARouter from './wa/router.js';

// Soporta tanto export default como named export { router }
const waRouter = WARouter.default ?? WARouter.router ?? WARouter;
if (typeof waRouter !== 'function') {
  throw new Error('wa/router.js debe exportar un Router de Express (default o named "router").');
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// Health / raíz
app.get('/', (_req, res) =>
  res.json({ ok: true, name: 'WA Bot', env: process.env.NODE_ENV || 'production' })
);
app.get('/health', (_req, res) =>
  res.json({ status: 'healthy', ts: new Date().toISOString() })
);

// Webhook WA
app.use('/wa', waRouter);

// Usar el puerto de Render y bindear a 0.0.0.0
const PORT = Number(process.env.PORT) || Number(config.PORT) || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] WA Bot listening on :${PORT} (TZ=${config.TIMEZONE || 'UTC'})`);
  if (config.DEBUG_LOGS) console.log('[BOOT] DEBUG_LOGS enabled');
  if (!config.WHATSAPP_TOKEN) console.warn('[WARN] WHATSAPP_TOKEN is not set. Outbound messages will fail.');
});
