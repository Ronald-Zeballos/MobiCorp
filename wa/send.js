// wa/send.js
import fs from 'fs';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { config } from '../env.js';

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';
const PHONE_ID = config.WHATSAPP_PHONE_ID;
const TOKEN = config.WHATSAPP_TOKEN;

function assertCreds() {
  if (!TOKEN || !PHONE_ID) { console.error('[WA] Missing WHATSAPP_TOKEN/WHATSAPP_PHONE_ID'); return false; }
  return true;
}

let chain = Promise.resolve();
function enqueue(fn) {
  chain = chain.then(async () => { await new Promise(r => setTimeout(r, 250)); return fn(); })
               .catch(e => console.error('[WA enqueue]', e));
  return chain;
}

async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const txt = await res.text();
  if (!res.ok) { console.error('[WA ERROR]', res.status, txt); return null; }
  try { return JSON.parse(txt); } catch { return txt; }
}

export function waSendText(to, body) {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } };
  if (config.DEBUG_LOGS) console.log('[WA -> text]', to, body);
  return enqueue(() => postJSON(url, payload));
}

export function waSendButtons(to, text, buttons = []) {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: { buttons: buttons.slice(0, 3).map((b, i) => ({ type: 'reply', reply: { id: b.id || b.value || `btn_${i}`, title: b.title?.slice(0, 20) || `Opción ${i+1}` } })) }
    }
  };
  if (config.DEBUG_LOGS) console.log('[WA -> buttons]', to, buttons.map(b => b.title).join('|'));
  return enqueue(() => postJSON(url, payload));
}

export async function waUploadMediaFromFile(filePath, mime = 'application/pdf', filename = 'file.pdf') {
  if (!assertCreds()) return null;
  const url = `${GRAPH_BASE}/${PHONE_ID}/media`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', fs.createReadStream(filePath), { filename });

  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
  const txt = await res.text();
  if (!res.ok) { console.error('[WA upload ERROR]', res.status, txt); return null; }
  try { const j = JSON.parse(txt); if (config.DEBUG_LOGS) console.log('[WA upload OK]', j.id, filename); return j.id; }
  catch { return null; }
}

export function waSendDocument(to, mediaId, filename = 'cotizacion.pdf', caption = '') {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = { messaging_product: 'whatsapp', to, type: 'document', document: { id: mediaId, filename, caption } };
  if (config.DEBUG_LOGS) console.log('[WA -> document]', to, filename, mediaId);
  return enqueue(() => postJSON(url, payload));
}

export function waSendImage(to, mediaId, caption = '') {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId, caption } };
  if (config.DEBUG_LOGS) console.log('[WA -> image]', to, caption, mediaId);
  return enqueue(() => postJSON(url, payload));
}

// === media download para visión
export async function waGetMediaUrl(mediaId) {
  if (!assertCreds()) return null;
  const metaUrl = `${GRAPH_BASE}/${mediaId}`;
  const r = await fetch(metaUrl, { headers: { Authorization: `Bearer ${TOKEN}` }});
  const txt = await r.text();
  if (!r.ok) { console.error('[WA media meta ERROR]', r.status, txt); return null; }
  try { const j = JSON.parse(txt); return j?.url || null; } catch { return null; }
}

export async function waDownloadMedia(mediaId) {
  const url = await waGetMediaUrl(mediaId);
  if (!url) return null;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` }});
  if (!r.ok) { console.error('[WA media download ERROR]', r.status); return null; }
  const buf = await r.arrayBuffer();
  return Buffer.from(buf);
}
