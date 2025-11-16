// src/aichat.js
// OpenAI Chat + Whisper + TTS (audio de respuesta) — versión para Mobicorp (mobiliario)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { config } from "../env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new OpenAI({
  apiKey: config.OPENAI_API_KEY || process.env.OPENAI_API_KEY
});
if (!client.apiKey) throw new Error("[IA] Falta OPENAI_API_KEY");

// ===== Config =====
const CHAT_MODEL    = process.env.OPENAI_MODEL       || "gpt-4o-mini";
const ASR_MODEL     = process.env.OPENAI_ASR_MODEL   || "whisper-1";
const TTS_MODEL     = process.env.OPENAI_TTS_MODEL   || "gpt-4o-mini-tts"; // texto → voz
const TTS_VOICE     = process.env.OPENAI_TTS_VOICE   || "nova";            // voz femenina
const MAX_TOKENS    = Number(process.env.AI_MAX_TOKENS    || 220);         // respuestas cortas
const MAX_HISTORY   = Number(process.env.AI_MAX_HISTORY   || 8);
const RETRIES       = Number(process.env.AI_RETRIES       || 3);
const BASE_DELAY_MS = Number(process.env.AI_BASE_DELAY_MS || 800);
const FORCE_ES      = (process.env.AI_FORCE_SPANISH || "1") === "1";

// ===== Utils =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.floor(ms * (0.75 + Math.random() * 0.5));
const cleanStr = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// ===== Prompt builder (Mobicorp / mobiliario) =====
function buildMessages(userText, history = [], extraSystem = "") {
  const hed = FORCE_ES ? "Responde siempre en español neutro (Bolivia o región). " : "";

  const role =
    "Eres *MobiBot*, el asistente virtual de *Mobicorp*, empresa especializada en mobiliario, equipamiento y soluciones para oficinas, empresas, coworks y espacios comerciales. ";

  const scope =
    "Tu foco son temas de mobiliario: sillas ergonómicas, escritorios, estaciones de trabajo, mesas de reunión, recepción, almacenamiento, call centers, equipamiento de oficinas, salas de espera y espacios corporativos en general. ";

  const tone =
    "Tu tono es profesional, cordial y cercano, como un asesor comercial que conoce muy bien el portafolio y entiende proyectos de oficinas modernas. Evita tecnicismos innecesarios y explicá de forma clara y concreta. ";

  const pricing =
    "No inventes precios exactos, descuentos ni condiciones comerciales específicas (plazos, garantías, entregas) si no están en el contexto. Cuando el usuario pregunte por precios concretos, podés orientarlo en rangos generales o recomendar que solicite una cotización formal. ";

  const flows =
    "Si el usuario menciona palabras como 'cotización', 'presupuesto', 'precio detallado', 'armar propuesta' o 'quiero cotizar', sugerí avanzar por el flujo de cotización que maneja el bot (sin describirlo técnicamente, solo dile que el bot le pedirá algunos datos para armar la propuesta). ";

  const catalog =
    "Si el usuario menciona 'catálogo', 'catalogo', 'modelos', 'ver opciones', 'ver sillas' o 'ver escritorios', recomendá usar el catálogo web de Mobicorp que el bot puede enviar por enlace, y luego continuar la conversación para afinar la elección. ";

  const location =
    "Si el usuario pregunta por 'ubicación', 'direccion', 'dónde están', 'donde queda la tienda', recalca que el bot puede enviar la ubicación oficial de Mobicorp y que allí puede ver el punto en el mapa. ";

  const safety =
    "No des consejos médicos, financieros, legales, ni opines de política o temas fuera de contexto. Si el usuario pregunta algo totalmente ajeno a mobiliario o a Mobicorp, responde brevemente que solo puedes ayudar con temas de mobiliario y proyectos de equipamiento de espacios, y sugerí que escriba palabras como 'catálogo' o 'cotización'. ";

  const brevity =
    "Mantén las respuestas breves y accionables: máximo 3–5 frases o, si corresponde, 4–6 viñetas cortas. No repitas saludos largos ni cierres redundantes. ";

  const format =
    "Cuando hagas recomendaciones, usa viñetas y menciona el tipo de producto (por ejemplo: 'silla ergonómica con apoyo lumbar', 'estación de trabajo para 4 puestos', 'mesa de reunión para 6–8 personas'). Si es útil, sugiere configuraciones de layout (disposición de puestos, recepción, sala de reunión, etc.). ";

  const closing =
    "Cierra, cuando tenga sentido, invitando a seguir con el catálogo o a solicitar una cotización para que el equipo de Mobicorp revise el proyecto. ";

  const sysParts = [
    hed,
    role,
    scope,
    tone,
    pricing,
    flows,
    catalog,
    location,
    safety,
    brevity,
    format,
    closing,
    extraSystem || ""
  ].filter(Boolean);

  const sys = sysParts.join(" ");

  const hist = (history || [])
    .slice(-MAX_HISTORY)
    .map((m) => ({
      role: m.role,
      content: cleanStr(m.content)
    }));

  const messages = [
    { role: "system", content: sys },
    ...hist,
    { role: "user", content: cleanStr(userText) }
  ];

  return messages;
}

// =============== Chat =================
/**
 * chatIA(userText, history?, extraSystem?)
 * - userText: mensaje del usuario
 * - history: arreglo [{role, content}]
 * - extraSystem: texto opcional para ajustar el comportamiento en un flujo concreto
 */
export async function chatIA(userText, history = [], extraSystem = "") {
  const text = cleanStr(userText);
  if (!text) {
    return "¿Podés contarme un poco más? Te ayudo con dudas sobre mobiliario, proyectos de oficina o una cotización.";
  }

  let attempt = 0;
  let lastErr;

  while (attempt < RETRIES) {
    try {
      const messages = buildMessages(text, history, extraSystem);
      const resp = await client.chat.completions.create({
        model: CHAT_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: MAX_TOKENS
      });
      const out = resp?.choices?.[0]?.message?.content?.trim();
      if (out) return out;
      return "No pude generar una respuesta clara, ¿podés resumir tu consulta en pocas palabras relacionada a mobiliario u oficinas?";
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.code || 500;

      if (
        status === 429 ||
        status === 500 ||
        status === 503 ||
        status === "ETIMEDOUT"
      ) {
        const hdr =
          err?.headers?.get?.("retry-after") ||
          err?.headers?.get?.("retry-after-ms");
        const serverWaitMs = hdr
          ? Number(hdr) * (hdr.endsWith?.("ms") ? 1 : 1000)
          : 0;
        const backoff = Math.min(12000, BASE_DELAY_MS * Math.pow(2, attempt));
        await sleep(Math.max(jitter(backoff), serverWaitMs));
        attempt++;
        continue;
      }

      if (status === 400 || status === 401 || status === 403) break;
      break;
    }
  }

  console.error("[IA chat] fallback:", lastErr);
  return "La IA está con tráfico alto. Probá de nuevo en un momento o escribí *cotización* o *catálogo* y el bot te guía paso a paso.";
}

// =============== Transcripción (Whisper) ===============
/**
 * transcribeAudio(buffer, filename)
 * Devuelve { text } usando whisper-1 (language: es).
 */
export async function transcribeAudio(buffer, filename = "audio.ogg") {
  const tmpDir = path.join(__dirname, "..", "data", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, filename);
  fs.writeFileSync(tmpPath, buffer);

  try {
    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: ASR_MODEL,
      language: "es"
    });
    return { text: cleanStr(result?.text || "") };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }
}

// =============== Síntesis de voz (texto → audio) ===============
/**
 * synthesizeSpeech(text, filename)
 * Convierte una respuesta corta en audio (mp3) con voz femenina.
 * Devuelve { path, filename } o null si no hay texto.
 */
export async function synthesizeSpeech(
  text,
  filename = "respuesta_mobicorp.mp3"
) {
  const safe = cleanStr(text);
  if (!safe) return null;

  const tmpDir = path.join(__dirname, "..", "data", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, filename);

  const speech = await client.audio.speech.create({
    model: TTS_MODEL,
    voice: TTS_VOICE,
    format: "mp3",
    input: safe
  });

  const buffer = Buffer.from(await speech.arrayBuffer());
  fs.writeFileSync(outPath, buffer);

  return {
    path: outPath,
    filename: path.basename(outPath)
  };
}
