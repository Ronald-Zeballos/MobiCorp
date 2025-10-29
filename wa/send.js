// wa/send.js
import fs from "fs";
import fetch from "node-fetch";
import FormData from "form-data";
import { config } from "../env.js";

const GRAPH_BASE = "https://graph.facebook.com/v20.0";
const PHONE_ID = config.WHATSAPP_PHONE_ID;
const TOKEN = config.WHATSAPP_TOKEN;

function assertCreds() {
  if (!TOKEN || !PHONE_ID) {
    console.error("[WA] Missing WHATSAPP_TOKEN/WHATSAPP_PHONE_ID");
    return false;
  }
  return true;
}

// Cola simple
let chain = Promise.resolve();
function enqueue(fn) {
  chain = chain.then(async () => {
    await new Promise(r => setTimeout(r, 250));
    return fn();
  }).catch(e => console.error("[WA enqueue]", e));
  return chain;
}

async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const txt = await res.text();
  if (!res.ok) {
    console.error("[WA ERROR]", res.status, txt);
    return null;
  }
  try { return JSON.parse(txt); } catch { return txt; }
}

export function waSendText(to, body) {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to, type: "text",
    text: { body, preview_url: false }
  };
  return enqueue(() => postJSON(url, payload));
}

export function waSendButtons(to, text, buttons = []) {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: buttons.slice(0, 3).map((b, i) => ({
          type: "reply",
          reply: { id: b.id || `btn_${i}`, title: (b.title || `Opción ${i+1}`).slice(0, 20) }
        }))
      }
    }
  };
  return enqueue(() => postJSON(url, payload));
}

// === NUEVO: Lista interactiva (menú y submenús) ===
export function waSendList(to, headerText, bodyText, sections = [], footerText = "") {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: headerText },
      body: { text: bodyText },
      footer: footerText ? { text: footerText } : undefined,
      action: {
        button: "Ver opciones",
        sections: sections.map((s, i) => ({
          title: s.title?.slice(0, 24) || `Sección ${i+1}`,
          rows: (s.rows || []).map(r => ({
            id: r.id,
            title: r.title?.slice(0, 24),
            description: r.description?.slice(0, 72)
          }))
        }))
      }
    }
  };
  return enqueue(() => postJSON(url, payload));
}

// === Media upload/download ===
export async function waUploadMediaFromFile(filePath, mime = "application/pdf", filename = "file.pdf") {
  if (!assertCreds()) return null;
  const url = `${GRAPH_BASE}/${PHONE_ID}/media`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", fs.createReadStream(filePath), { filename });

  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
  const txt = await res.text();
  if (!res.ok) {
    console.error("[WA upload ERROR]", res.status, txt);
    return null;
  }
  try { return JSON.parse(txt).id; } catch { return null; }
}

export function waSendDocument(to, mediaId, filename = "cotizacion.pdf", caption = "") {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: { id: mediaId, filename, caption }
  };
  return enqueue(() => postJSON(url, payload));
}

export function waSendImage(to, mediaId, caption = "") {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { id: mediaId, caption }
  };
  return enqueue(() => postJSON(url, payload));
}

// === NUEVO: helper enviar imagen desde archivo ===
export async function waSendImageFromFile(to, filePath, caption = "") {
  const ext = (filePath.split(".").pop() || "jpg").toLowerCase();
  const mime = ext === "png" ? "image/png" :
               ext === "webp" ? "image/webp" : "image/jpeg";
  const filename = filePath.split("/").pop();
  const id = await waUploadMediaFromFile(filePath, mime, filename);
  if (id) return waSendImage(to, id, caption);
  return false;
}

// === NUEVO: descargar media entrante (audio) ===
export async function waGetMediaUrl(mediaId) {
  const url = `${GRAPH_BASE}/${mediaId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) { console.error("[WA get media url]", await res.text()); return null; }
  const j = await res.json();
  return j?.url || null;
}

export async function waDownloadMedia(mediaUrl, outPath) {
  const res = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) { console.error("[WA media download]", await res.text()); return null; }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  return outPath;
}
