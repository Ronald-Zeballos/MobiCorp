// --- Opciones estáticas del flujo ---
export const DEPARTAMENTOS = [
  "Santa Cruz","Cochabamba","La Paz","Chuquisaca","Tarija","Oruro","Potosí","Beni","Pando"
];

export const SUBZONAS_SCZ = [
  "Norte Integrado","Norte","Este","Sur","Valles","Chiquitania"
];

export const CROP_OPTIONS = [
  { title: "Soya", payload: "CROP_SOYA" },
  { title: "Maíz", payload: "CROP_MAIZ" },
  { title: "Trigo", payload: "CROP_TRIGO" },
  { title: "Arroz", payload: "CROP_ARROZ" },
  { title: "Girasol", payload: "CROP_GIRASOL" },
  { title: "Otro", payload: "CROP_OTRO" }
];

export const HECTARE_OPTIONS = [
  { title:"0–100 ha",       payload:"HA_0_100" },
  { title:"101–300 ha",     payload:"HA_101_300" },
  { title:"301–500 ha",     payload:"HA_301_500" },
  { title:"1,000–3,000 ha", payload:"HA_1000_3000" },
  { title:"3,001–5,000 ha", payload:"HA_3001_5000" },
  { title:"+5,000 ha",      payload:"HA_5000_MAS" },
  { title:"Otras cantidades", payload:"HA_OTRA" }
];

export const CAMP_BTNS = [
  { title:"Verano",   payload:"CAMP_VERANO" },
  { title:"Invierno", payload:"CAMP_INVIERNO" }
];

// === ESTE FALTABA (lo pide router.js) ===
export const btnCotizar = [
  { title: "Cotizar", payload: "QR_FINALIZAR" }
];

// Helpers para construir textos/filas (si no los tienes ya)
export function btnsDepartamentos() {
  return DEPARTAMENTOS.map(d => ({ title: d, payload: `DPTO_${d.toUpperCase().replace(/\s+/g,'_')}` }));
}
export function btnsSubzonasSCZ() {
  return SUBZONAS_SCZ.map(z => ({ title: z, payload: `SUBZ_${z.toUpperCase().replace(/\s+/g,'_')}` }));
}
export function btnsCultivos() {
  return CROP_OPTIONS;
}
export function btnsHectareas() {
  return HECTARE_OPTIONS;
}
export function btnsCampana() {
  return CAMP_BTNS;
}

// Resumen (ajústalo si ya tienes otro)
export function summaryText(s) {
  const nombre = s.profileName || 'Cliente';
  const dep    = s.vars?.departamento || 'ND';
  const zona   = s.vars?.subzona || 'ND';
  const cultivo= (s.vars?.cultivos && s.vars.cultivos[0]) || 'ND';
  const ha     = s.vars?.hectareas || 'ND';
  const camp   = s.vars?.campana || 'ND';

  const prods = (s.vars?.cart||[]).length
    ? s.vars.cart.map(it => `• ${it.nombre}${it.presentacion?` (${it.presentacion})`:''} — ${it.cantidad}`).join('\n')
    : '• (pendiente: añade productos desde el catálogo)';

  return [
    '🧾 *Resumen de solicitud*',
    `• Cliente: *${nombre}*`,
    `• Departamento: *${dep}*`,
    `• Subzona: *${zona}*`,
    `• Cultivo: *${cultivo}*`,
    `• Hectáreas: *${ha}*`,
    `• Campaña: *${camp}*`,
    '',
    prods
  ].join('\n');
}
