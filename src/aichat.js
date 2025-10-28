// src/aichat.js
import OpenAI from "openai";
import { config } from "../env.js";

const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// parámetros conservadores para no disparar TPM
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = 320;               // baja tokens de salida
const MAX_HISTORY = 8;                // recortar contexto
const RETRIES = 3;                    // reintentos en 429/5xx
const BASE_DELAY_MS = 800;            // backoff base

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

export async function chatIA(userText, history = []) {
  // recortar historial al final
  const hist = history.slice(-MAX_HISTORY);

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
      return resp.choices?.[0]?.message?.content?.trim() || "No pude generar respuesta.";
    } catch (err) {
      lastErr = err;
      // Manejo específico de 429 / rate limit
      const code = err?.status || err?.code;
      if (code === 429 || code === 500 || code === 503) {
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
  // Último recurso: mensaje amable
  console.error("[IA] fallback:", lastErr);
  return "La IA está ocupada ahora mismo. Intento de nuevo si me escribes otro mensaje o puedes escribir *volver* para ir al menú.";
}
