// core/intents.js

// Normalizador
const norm = (s = '') => s.toString().trim().toLowerCase();

// ---- Detectores de intención ----
export function wantsCatalog(text) {
  const t = norm(text);
  return /catalogo|catálogo|ver productos|lista de precios/.test(t);
}
export function wantsLocation(text) {
  const t = norm(text);
  return /ubicaci(ón|on)|mapa|cómo llegar|donde están|dónde están/.test(t);
}
export function wantsHuman(text) {
  const t = norm(text);
  return /(asesor|humano|agente|hablar con alguien|soporte)/.test(t);
}
export function wantsClose(text) {
  const t = norm(text);
  return /(fin|terminar|gracias|chau|cerrar|finalizar)/.test(t);
}
export function wantsPrice(text) {
  const t = norm(text);
  return /(precio|cotizar|cotizaci(ón|on)|presupuesto)/.test(t);
}
export function looksLikeFullName(text) {
  const t = (text ?? '').trim();
  return t.split(/\s+/).length >= 2 && /^[a-zA-ZñÑáéíóúÁÉÍÓÚ\s'.-]+$/.test(t);
}

// ---- Catálogos / opciones (USADOS por flow.js) ----
export const DEPARTAMENTOS = [
  'Santa Cruz','Beni','Pando','La Paz','Cochabamba','Oruro','Potosí','Chuquisaca','Tarija'
];

export const SUBZONAS_SCZ = [
  'Norte Integrado','Chiquitania','Vallegrande','Cordillera','Andrés Ibáñez','Warnes','Obispo Santistevan'
];

export const CROP_OPTIONS = ['Soya','Maíz','Trigo','Arroz','Girasol','Otro…'];

export const HA_RANGES = ['<50','50-100','100-300','300-500','>500','Otra…'];

// ---- Parsers / detectores de campos ----
export function detectDepartamento(text) {
  const t = norm(text);
  return DEPARTAMENTOS.find(d => norm(d) === t) || null;
}
export function detectSubzona(text) {
  const t = norm(text);
  return SUBZONAS_SCZ.find(z => norm(z) === t) || null;
}
export function parseHectareas(text) {
  const t = norm(text).replace(',', '.');
  const m = t.match(/(\d+(\.\d+)?)/);
  if (m) return Number(m[1]);
  if (HA_RANGES.includes(text)) return text;
  return null;
}
