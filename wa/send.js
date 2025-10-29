// wa/send.js
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import FormData from "form-data";
import { config } from "../env.js";

// ---- WhatsApp Graph config ----
const GRAPH_BASE = "https://graph.facebook.com/v20.0";
const PHONE_ID   = config.WHATSAPP_PHONE_ID;
const TOKEN      = config.WHATSAPP_TOKEN;

function assertCreds() {
  if (!PHONE_ID || !TOKEN) {
    console.error("[WA] Falta WHATSAPP_PHONE_ID o WHATSAPP_TOKEN");
    return false;
  }
  return true;
}

// ---- HTTP helpers ----
async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>"(no body)");
    throw new Error(`[WA] POST ${url} ${res.status}: ${t}`);
  }
  return res.json();
}

// Cola ligera para no saturar el rate-limit
const queue = [];
let running = false;
async function runQueue() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try { await job(); }
    catch (e) { console.error("[WA queue] error:", e.message); }
    await new Promise(r=>setTimeout(r, 120)); // leve pacing
  }
  running = false;
}
function enqueue(fn) { queue.push(fn); runQueue(); }

// ---- MIME helper básico ----
function guessMimeByName(name = "") {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "pdf") return "application/pdf";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "mp3") return "audio/mpeg";
  return "application/octet-stream";
}

// ======================================================
// =============== Envíos de mensajes ===================
// ======================================================

export function waSendText(to, text) {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: false, body: text }
  };
  if (config.DEBUG_LOGS) console.log("[WA -> text]", to, text?.slice(0, 120));
  return enqueue(() => postJSON(url, payload));
}

export function waSendList(to, bodyText, rows = []) {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: "Elegir",
        sections: [{
          title: "Opciones",
          rows: rows.map(r => ({
            id: r.id,
            title: (r.title || "").slice(0, 24),
            description: r.description ? (r.description || "").slice(0, 60) : undefined
          }))
        }]
      }
    }
  };
  if (config.DEBUG_LOGS) console.log("[WA -> list]", to, rows.map(r=>r.id).join(","));
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
  if (config.DEBUG_LOGS) console.log("[WA -> image]", to, caption, mediaId);
  return enqueue(() => postJSON(url, payload));
}

export function waSendDocument(to, mediaId, filename = "archivo.pdf", caption = "") {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: { id: mediaId, filename, caption }
  };
  if (config.DEBUG_LOGS) console.log("[WA -> document]", to, filename, mediaId);
  return enqueue(() => postJSON(url, payload));
}

// ======================================================
// =============== Upload de media local ===============
// ======================================================
/**
 * Sube un archivo local (imagen/pdf/audio) al media endpoint de WhatsApp
 * y devuelve el mediaId para usar con waSendImage/waSendDocument.
 *
 * @param {string} filePath - ruta absoluta o relativa
 * @param {string} mimeType - ej: "image/jpeg"
 * @param {string} filename - nombre que verá el usuario (opcional)
 * @returns {Promise<string|null>} mediaId
 */
export async function waUploadMediaFromFile(filePath, mimeType, filename) {
  if (!assertCreds()) return null;

  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    console.error("[WA upload] no existe", abs);
    return null;
  }

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType || guessMimeByName(filename || filePath));
  form.append("file", fs.createReadStream(abs), filename || path.basename(abs));

  const url = `${GRAPH_BASE}/${PHONE_ID}/media`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>"(no body)");
    throw new Error(`[WA] media upload ${res.status}: ${t}`);
  }
  const data = await res.json();
  const mediaId = data?.id || data?.media?.id || null;
  if (config.DEBUG_LOGS) console.log("[WA upload] -> id:", mediaId, "file:", abs);
  return mediaId;
}
