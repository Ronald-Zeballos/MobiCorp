// core/flow.js
// UI helpers para WhatsApp + copy mejorado y anti-duplicados
import { parseHectareas, detectDepartamento, detectSubzona, shouldCloseNow } from "./ai.js";

export const DEPARTAMENTOS = ['Santa Cruz','Cochabamba','La Paz','Chuquisaca','Tarija','Oruro','Potosí','Beni','Pando'];
export const SUBZONAS_SCZ  = ['Norte','Este','Sur','Valles','Chiquitania'];

const HA_OPTIONS = [
  { id:'HA_0_100',      label:'0–100 ha' },
  { id:'HA_101_300',    label:'101–300 ha' },
  { id:'HA_301_500',    label:'301–500 ha' },
  { id:'HA_1000_3000',  label:'1,000–3,000 ha' },
  { id:'HA_3001_5000',  label:'3,001–5,000 ha' },
  { id:'HA_5000_MAS',   label:'+5,000 ha' },
  { id:'HA_OTRA',       label:'Otras cantidades' }
];

export function debounceAsk(s, key) {
  if (s.lastPrompt === key && Date.now() - (s.lastPromptTs||0) < 20000) return false;
  s.lastPrompt = key; s.lastPromptTs = Date.now();
  return true;
}

// ==== Preguntas adaptativas (solo lo que falta) ====
export async function smartAskNext(to, s, ui) {
  // Si ya listo para cierre, no preguntes más
  if (shouldCloseNow(s)) return await askForQuoteConfirmation(to, s, ui);

  if (!s.profileName && debounceAsk(s,'nombre')) {
    return ui.text(to, "¡Hola! Soy tu asistente 🤝\nPara personalizar tu atención, ¿cómo te llamas? *(Nombre y apellido)*");
  }

  if (!s.vars?.departamento && debounceAsk(s,'departamento')) {
    return ui.list(to, "📍 ¿Desde qué *departamento* de Bolivia nos escribes?", "Elegir departamento",
      DEPARTAMENTOS.map(d => ({ id:`DPTO_${d}`, title:d })));
  }

  if (s.vars?.departamento === 'Santa Cruz' && !s.vars?.subzona && debounceAsk(s,'subzona_scz')) {
    return ui.list(to, "Gracias. ¿En qué *zona de Santa Cruz* estás?", "Elegir zona",
      SUBZONAS_SCZ.map(z => ({ id:`SUBZ_${z.toUpperCase()}`, title:z })));
  }

  if (!s.vars?.subzona && s.vars?.departamento && debounceAsk(s,'subzona_libre')) {
    return ui.text(to, `Perfecto. ¿Cuál es tu *zona* en *${s.vars.departamento}*?`);
  }

  if ((!s.vars?.cultivos || !s.vars.cultivos.length) && debounceAsk(s,'cultivo')) {
    return ui.list(to, "🧑‍🌾 ¿Para qué *cultivo* necesitas el producto?", "Elegir cultivo", [
      { id:"CROP_Soya", title:"Soya" },
      { id:"CROP_Maíz", title:"Maíz" },
      { id:"CROP_Trigo", title:"Trigo" },
      { id:"CROP_Arroz", title:"Arroz" },
      { id:"CROP_Girasol", title:"Girasol" },
      { id:"CROP_Otro", title:"Otro" }
    ]);
  }

  if (!s.vars?.hectareas && debounceAsk(s,'hectareas')) {
    return ui.list(to, "📏 ¿Cuántas *hectáreas* vas a tratar?", "Elegir hectáreas",
      HA_OPTIONS.map(x => ({ id:x.id, title:x.label })));
  }

  if (!s.vars?.campana && debounceAsk(s,'campana')) {
    return ui.buttons(to, "🗓️ ¿En qué *campaña* te encuentras?", [
      { id:"CAMP_Verano", title:"Verano" },
      { id:"CAMP_Invierno", title:"Invierno" }
    ]);
  }
}

// ==== Resumen y CTA único ====
export async function askForQuoteConfirmation(to, s, ui) {
  if (!debounceAsk(s,'confirm_quote')) return;
  const nombre = s.profileName || 'Cliente';
  const dep    = s.vars?.departamento || '—';
  const zona   = s.vars?.subzona || '—';
  const cultivo= s.vars?.cultivos?.[0] || '—';
  const ha     = s.vars?.hectareas || '—';
  const camp   = s.vars?.campana || '—';

  const texto = [
    "📝 *Resumen de solicitud*",
    `• Cliente: *${nombre}*`,
    `• Departamento: *${dep}*`,
    `• Subzona: *${zona}*`,
    `• Cultivo: *${cultivo}*`,
    `• Hectáreas: *${ha}*`,
    `• Campaña: *${camp}*`,
    "",
    "¿Confirmas estos datos para generar tu *cotización en PDF*?"
  ].join("\n");

  await ui.text(to, texto);
  return ui.buttons(to, "Continuar", [{ id:"ACTION_GENERAR_PDF", title:"✅ Confirmar y generar PDF" }]);
}
