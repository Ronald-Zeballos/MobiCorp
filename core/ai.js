// core/ai.js
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

const MODEL_VISION = process.env.OPENAI_MODEL_VISION || "gpt-4o-mini";
const MODEL_TEXT   = process.env.OPENAI_MODEL_TEXT   || "gpt-4o-mini";
const AI_DEBUG     = process.env.AI_DEBUG === "1";

/**
 * Pequeño “contrato” de salida para que la IA NO devuelva bla-bla,
 * solo JSON con { action, reason?, entities?, cart? }.
 */
function iaSystemPrompt() {
  return `
Eres un orquestador de conversaciones de ventas para agroquímicos.
Devuelve SIEMPRE un JSON válido con estas claves:

- action: one of [
  "ask_nombre","ask_departamento","ask_subzona",
  "ask_cultivo","ask_hectareas","ask_campana",
  "show_catalog","add_to_cart","summarize","close_quote",
  "handoff_human","smalltalk"
]
- entities: { nombre?, departamento?, subzona?, cultivo?, hectareas?, campana?, producto?, cantidad? }
- cart: [{ nombre, presentacion?, cantidad? }]  // opcional si infieres un pedido
- reason: breve explicación (string)

Reglas:
- Si el usuario quiere hablar con humano: action="handoff_human".
- Si detectas intención de cerrar, usa action="close_quote".
- Si falta algún dato clave, usa la acción ask_* correspondiente.
- Nunca salgas del JSON.
`;
}

export async function aiDecideNext({ message, session }) {
  const vars = session?.vars || {};
  const context = {
    known: {
      nombre: session?.profileName || null,
      departamento: vars.departamento || null,
      subzona: vars.subzona || null,
      cultivo: (vars.cultivos && vars.cultivos[0]) || null,
      hectareas: vars.hectareas || null,
      campana: vars.campana || null
    },
    cart: vars.cart || []
  };

  const user = typeof message === "string" ? message : (message?.text || "");
  const sys = iaSystemPrompt();

  const resp = await client.chat.completions.create({
    model: MODEL_TEXT,
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify({ user, context }) }
    ],
    response_format: { type: "json_object" }
  });

  const out = safeJSON(resp.choices?.[0]?.message?.content);
  if (AI_DEBUG) console.log("[AI decide] =>", out);
  return out || { action: "smalltalk", reason: "fallback" };
}

function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }

/**
 * Dado una imagen de usuario, pregunta a la IA visión si coincide con un
 * producto del catálogo. Le pasamos lista de candidatos (nombre + alias).
 * 
 * @param {string} imageUrl - URL pública de la imagen (o data URL)
 * @param {Array} catalog - productos [{nombre, syns?, imagen?}, ...]
 * @returns { { match: {nombre, presentacion?} | null, confidence: number, reason: string } }
 */
export async function aiMatchCatalogFromImage({ imageUrl, catalog }) {
  const topK = 12; // no pases catálogos enormes de golpe; recorta si es muy grande
  const mini = (catalog || []).slice(0, topK).map(p => ({
    nombre: p.nombre,
    presentacion: p.presentacion || null,
    alias: [
      p.ingrediente_activo, p.ia, p.activo,
      ...(Array.isArray(p.syns_activo) ? p.syns_activo : []),
      ...(Array.isArray(p.alias) ? p.alias : [])
    ].filter(Boolean)
  }));

  const prompt = [
    "Tarea: dime cuál de estos productos del catálogo se parece más a la FOTO del usuario.",
    "Devuelve estrictamente JSON: {match:{nombre, presentacion?}|null, confidence:0..1, reason:string}",
    "Catálogo:",
    JSON.stringify(mini)
  ].join("\n");

  const msgs = [
    { role: "system", content: "Eres un experto reconociendo etiquetas/fichas de productos agroquímicos." },
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "input_image", image_url: { url: imageUrl } }
      ]
    }
  ];

  const resp = await client.chat.completions.create({
    model: MODEL_VISION,
    messages: msgs,
    temperature: 0.2,
    response_format: { type: "json_object" }
  });

  const out = safeJSON(resp.choices?.[0]?.message?.content) || { match:null, confidence:0, reason:"" };
  if (AI_DEBUG) console.log("[AI vision] =>", out);
  return out;
}
