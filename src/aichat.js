// src/aichat.js
// OpenAI-only: Chat y Whisper (transcripción de audio)

import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { config } from "../env.js";

const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-1";

const MAX_TOKENS    = Number(process.env.AI_MAX_TOKENS || 320);
const MAX_HISTORY   = Number(process.env.AI_MAX_HISTORY || 8);
const RETRIES       = Number(process.env.AI_RETRIES || 3);
const BASE_DELAY_MS = Number(process.env.AI_BASE_DELAY_MS || 800);

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// === Chat IA (texto-tipo ChatGPT) ===
export async function chatIA(userText, history = []) {
  const hist = (history || []).slice(-MAX_HISTORY);

  const messages = [
    { role: "system", content:
      "Eres AgroBot de NewChem Agroquímicos. Sé claro, breve y útil. " +
      "Responde dudas sobre cultivos, plagas, productos y logística. " +
      "Si no tienes el dato de precios/stock, dilo y ofrece cotizar. " +
      "Nunca inventes precios. Tono amable y profesional para Bolivia." },
    ...hist,
    { role: "user", content: userText }
  ];

  let attempt = 0, lastErr;
  while (attempt < RETRIES) {
    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        messages,
        temperature: 0.4,
        max_tokens: MAX_TOKENS
      });
      return resp?.choices?.[0]?.message?.content?.trim() || "No pude generar respuesta.";
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.code || 500;

      if (status === 429 || status === 500 || status === 503) {
        const retryAfterSec =
          Number(err?.headers?.get?.("retry-after")) ||
          Number(err?.headers?.get?.("retry-after-ms"))/1000 || 0;
        const backoff = Math.min(8000, BASE_DELAY_MS * Math.pow(2, attempt));
        const waitMs = Math.max(backoff, retryAfterSec * 1000);
        await sleep(waitMs);
        attempt++;
        continue;
      }
      throw err;
    }
  }
  console.error("[IA] fallback:", lastErr);
  return "La IA está ocupada ahora mismo. Intento de nuevo si me escribes otro mensaje o puedes escribir *volver* para ir al menú.";
}

// === Whisper (transcripción) desde archivo en disco ===
export async function transcribeAudioFile(filePath) {
  const filename = path.basename(filePath);
  const stream = fs.createReadStream(filePath);
  const resp = await client.audio.transcriptions.create({
    file: stream,
    model: WHISPER_MODEL,
    response_format: "verbose_json"
  });
  return resp?.text?.trim() || "";
}

// === Whisper (transcripción) desde Buffer (por si ya lo bajaste en memoria) ===
export async function transcribeAudioBuffer(buffer, filename = "audio.ogg") {
  // Node 18+ soporta File en el SDK
  const file = new File([buffer], filename, { type: "application/octet-stream" });
  const resp = await client.audio.transcriptions.create({
    file,
    model: WHISPER_MODEL,
    response_format: "verbose_json"
  });
  return resp?.text?.trim() || "";
}
