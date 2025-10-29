// src/aichat.js
// OpenAI Chat + Whisper (transcripción)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { config } from "../env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = new OpenAI({ apiKey: config.OPENAI_API_KEY || process.env.OPENAI_API_KEY });
if (!client.apiKey) throw new Error("[IA] Falta OPENAI_API_KEY");

const CHAT_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ASR_MODEL    = process.env.OPENAI_ASR_MODEL || "whisper-1";          // speech->text
const MAX_TOKENS   = Number(process.env.AI_MAX_TOKENS || 320);
const MAX_HISTORY  = Number(process.env.AI_MAX_HISTORY || 8);
const RETRIES      = Number(process.env.AI_RETRIES || 3);
const BASE_DELAY_MS= Number(process.env.AI_BASE_DELAY_MS || 800);

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// =============== Chat =================
export async function chatIA(userText, history = []) {
  const hist = (history || []).slice(-MAX_HISTORY);
  const messages = [
    { role: "system", content:
      "Eres AgroBot de NewChem Agroquímicos. Sé claro, amable y útil. " +
      "Responde dudas sobre cultivos, plagas, productos y logística en Bolivia. " +
      "Si no tienes el dato de precios/stock, dilo y ofrece cotizar. No inventes precios." },
    ...hist,
    { role: "user", content: userText }
  ];

  let attempt = 0, lastErr;
  while (attempt < RETRIES) {
    try {
      const resp = await client.chat.completions.create({
        model: CHAT_MODEL,
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
        await sleep(Math.max(backoff, retryAfterSec * 1000));
        attempt++;
        continue;
      }
      throw err;
    }
  }
  console.error("[IA chat] fallback:", lastErr);
  return "La IA está ocupada ahora mismo. Escribime de nuevo o poné *volver* para ir al menú.";
}

// =============== Transcripción (Whisper) ===============
/**
 * transcribeAudio(buffer, filename)
 * Devuelve { text } usando whisper-1.
 */
export async function transcribeAudio(buffer, filename = "audio.ogg") {
  // guardamos temporalmente para el SDK
  const tmpDir = path.join(__dirname, "..", "data", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, filename);
  fs.writeFileSync(tmpPath, buffer);

  try {
    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: ASR_MODEL, // "whisper-1"
      // language: "es"  // opcional
    });
    return { text: (result?.text || "").trim() };
  } finally {
    // limpia archivo
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
