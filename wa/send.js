// wa/send.js
import fs from 'fs';
import path from 'path';
import { config } from '../env.js';

// Config WA Cloud API
const GRAPH_BASE = 'https://graph.facebook.com/v19.0';
const PHONE_ID = config.WHATSAPP_PHONE_ID;
const TOKEN = config.WHATSAPP_TOKEN;

function assertCreds() {
  if (!TOKEN || !PHONE_ID) {
    console.error('[WA] Falta WHATSAPP_TOKEN o WHATSAPP_PHONE_ID');
    return false;
  }
  return true;
}

// Cola simple para evitar 429 (Too Many Requests)
let chain = Promise.resolve();
const SLEEP_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function enqueue(fn) {
  chain = chain.then(async () => {
    const res = await fn();
    await sleep(SLEEP_MS);
    return res;
  }).catch((e) => {
    console.error('[WA] queue error:', e);
  });
  return chain;
}

// --- Helpers HTTP ---
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[WA] POST JSON error', res.status, data);
    throw new Error(`WA HTTP ${res.status}`);
  }
  return data;
}

async function postForm(url, formData) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`
      // Content-Type la pone fetch con boundary automáticamente
    },
    body: formData
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[WA] POST FORM error', res.status, data);
    throw new Error(`WA HTTP ${res.status}`);
  }
  return data;
}

// --- API de envío ---

/**
 * Envía texto plano
 * @param {string} to - número en formato internacional sin + (ej: 5917XXXXXXX)
 * @param {string} body - texto
 */
export function waSendText(to, body) {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  };
  if (config.DEBUG_LOGS) console.log('[WA -> text]', to, body.slice(0, 80));
  return enqueue(() => postJSON(url, payload));
}

/**
 * Envía botones (interactive/button)
 * @param {string} to
 * @param {string} text - cuerpo visible
 * @param {Array<{id:string,title:string}>} buttons
 */
export function waSendButtons(to, text, buttons = []) {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;

  const mapped = buttons.slice(0, 3).map(b => ({
    type: 'reply',
    reply: { id: String(b.id), title: String(b.title).slice(0, 20) } // WA limita a 20 chars
  }));

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: { buttons: mapped }
    }
  };
  if (config.DEBUG_LOGS) console.log('[WA -> buttons]', to, mapped.map(b => b.reply.id));
  return enqueue(() => postJSON(url, payload));
}

/**
 * Sube un archivo local al Graph y devuelve mediaId
 * @param {string} filePath - ruta local (ej: /tmp/x.pdf)
 * @param {string} mime - ej: application/pdf
 * @param {string} filename - nombre sugerido
 * @returns {Promise<string|null>} mediaId
 */
export async function waUploadMediaFromFile(filePath, mime = 'application/octet-stream', filename) {
  if (!assertCreds()) return null;
  const url = `${GRAPH_BASE}/${PHONE_ID}/media`;

  const abs = path.resolve(filePath);
  const buf = fs.readFileSync(abs);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  // En Node 18+ existe Blob global
  const blob = new Blob([buf], { type: mime });
  // Algunos runtimes requieren filename explícito
  form.append('file', blob, filename || path.basename(abs));

  if (config.DEBUG_LOGS) console.log('[WA -> upload]', filename || path.basename(abs), mime);
  try {
    const data = await enqueue(() => postForm(url, form));
    const id = data?.id || data?.media?.id || null;
    if (!id) console.error('[WA] upload sin id:', data);
    return id;
  } catch (e) {
    console.error('[WA] upload error:', e);
    return null;
  }
}

/**
 * Envía documento (PDF) previamente subido (por mediaId)
 * @param {string} to
 * @param {string} mediaId
 * @param {string} filename
 * @param {string} caption
 */
export function waSendDocument(to, mediaId, filename = 'document.pdf', caption = '') {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: { id: mediaId, filename, caption }
  };
  if (config.DEBUG_LOGS) console.log('[WA -> document]', to, filename, mediaId);
  return enqueue(() => postJSON(url, payload));
}
