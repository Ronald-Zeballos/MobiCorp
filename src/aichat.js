// src/aichat.js
// Proveedor IA intercambiable: OpenAI o Groq (según AI_PROVIDER)

import { config } from "../env.js";

// ===== Selector de proveedor =====
const PROVIDER = (process.env.AI_PROVIDER || config.AI_PROVIDER || "openai").toLowerCase();

let client;     // instancia de SDK
let doChat;     // función para llamar al provider

// Carga dinámica para no romper ESM en runtime (Node 18+ soporta top-level await)
if (PROVIDER === "groq") {
  const { default: Groq } = await import("groq-sdk");
  client = new Groq({ apiKey: process.env.GROQ_API_KEY || config.GROQ_API_KEY });
  if (!client.apiKey) throw new Error("[IA] Falta GROQ_API_KEY");
  doChat = async (payload) => client.chat.completions.create(payload);
} else {
  const { default: OpenAI } = await import("openai");
  client = new OpenAI({ apiKey: config.OPENAI_API_KEY || process.env.OPENAI_API_KEY });
  if (!client.apiKey) throw new Error("[IA] Falta OPENAI_API_KEY");
  doChat = async (payload) => client.chat.completions.create(payload);
}

// ===== Parámetros (seguros) =====
const MODEL =
  PROVIDER === "groq"
    ? (process.env.GROQ_MODEL || config.GROQ_MODEL || "llama-3.1-70b-versatile")
    : (process.env.OPENAI_MODEL || config.OPENAI_MODEL || "gpt-4o-mini");

const MAX_TOKENS    = Number(process.env.AI_MAX_TOKENS || 320); // salida moderada
const MAX_HISTORY   = Number(process.env.AI_MAX_HISTORY || 8);  // recortar historial
const RETRIES       = Number(process.env.AI_RETRIES || 3);      // reintentos en 429/5xx
const BASE_DELAY_MS = Number(process.env.AI_BASE_DELAY_MS || 800); // backoff exponencial

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// ===== Interfaz única =====
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
      const resp = await doChat({
        model: MODEL,
        messages,
        temperature: 0.4,
        max_tokens: MAX_TOKENS
      });
      // OpenAI y Groq comparten estructura: .choices[0].message.content
      return resp?.choices?.[0]?.message?.content?.trim() || "No pude generar respuesta.";
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.code || 500;

      // Backoff para 429/5xx (Groq y OpenAI)
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
