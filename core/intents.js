// core/intents.js
const norm = (s = '') => s.toString().trim()
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase();

export function wantsCatalog(text) { const t = norm(text); return /catalogo|catalogo|catálogo|ver productos|lista de precios/.test(t); }
export function wantsLocation(text) { const t = norm(text); return /ubicacion|mapa|como llegar|donde estan/.test(t); }
export function wantsHuman(text) { const t = norm(text); return /(asesor|humano|agente|hablar con alguien|soporte|llamar)/.test(t); }
export function wantsClose(text) { const t = norm(text); return /(fin|terminar|gracias|chau|cerrar|finalizar)/.test(t); }
export function wantsPrice(text) { const t = norm(text); return /(precio|cotizar|cotizacion|cotización|presupuesto)/.test(t); }
export function looksLikeFullName(text) {
  const t = (text ?? '').trim();
  return t.split(/\s+/).length >= 2 && /^[a-zA-ZñÑáéíóúÁÉÍÓÚ\s'.-]+$/.test(t);
}

// Catálogos / opciones
export const DEPARTAMENTOS = [
  'Santa Cruz','Beni','Pando','La Paz','Cochabamba','Oruro','Potosí','Chuquisaca','Tarija'
];
export const SUBZONAS_SCZ = [
  'Norte Integrado','Chiquitania','Vallegrande','Cordillera','Andrés Ibáñez','Warnes','Obispo Santistevan'
];
export const CROP_OPTIONS = ['Soya','Maíz','Trigo','Arroz','Girasol','Otro…'];
export const HA_RANGES = ['<50','50-100','100-300','300-500','>500','Otra…'];

// Fuzzy helpers
const depSyn = {
  'santacruz':'Santa Cruz', 'scz':'Santa Cruz', 'sta cruz':'Santa Cruz', 'sta-cruz':'Santa Cruz',
  'lapaz':'La Paz', 'lpz':'La Paz',
  'cocha':'Cochabamba'
};
function eq(a,b){return norm(a)===norm(b);}
function fuzzyIncludes(hay, needle){ return norm(hay).includes(norm(needle)); }

export function detectDepartamento(text) {
  const t = norm(text);
  for (const d of DEPARTAMENTOS) if (eq(d, t)) return d;
  // synonyms
  for (const [k,v] of Object.entries(depSyn)) if (t.includes(k)) return v;
  // loose include
  for (const d of DEPARTAMENTOS) if (fuzzyIncludes(t,d)) return d;
  return null;
}
export function detectSubzona(text) {
  const t = norm(text);
  for (const z of SUBZONAS_SCZ) if (eq(z, t)) return z;
  for (const z of SUBZONAS_SCZ) if (fuzzyIncludes(t, z)) return z;
  // alias simples
  if (/\bwarnes\b/.test(t)) return 'Warnes';
  if (/\bchiqui(tania)?\b/.test(t)) return 'Chiquitania';
  return null;
}
export function parseHectareas(text) {
  const t = norm(text).replace(',', '.');
  const m = t.match(/(\d+(\.\d+)?)/);
  if (m) return Number(m[1]);
  if (HA_RANGES.includes(text)) return text;
  return null;
}
