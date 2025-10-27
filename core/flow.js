// core/flow.js
import { CROP_OPTIONS, DEPARTAMENTOS, SUBZONAS_SCZ, HA_RANGES } from './intents.js';

// --- Constructores de botones (WhatsApp interactive/button) ---
export function btnsDepartamento() {
  return DEPARTAMENTOS.map((d, i) => ({ id: `dep_${i}`, title: d }));
}

export function btnsSubzonaSCZ() {
  return SUBZONAS_SCZ.map((z, i) => ({ id: `sub_${i}`, title: z }));
}

export function btnsCultivos() {
  return CROP_OPTIONS.map((c, i) => ({ id: `crop_${i}`, title: c }));
}

export function btnsHectareas() {
  return HA_RANGES.map((h, i) => ({ id: `ha_${i}`, title: h }));
}

export function btnsCampana() {
  return [
    { id: 'camp_verano',  title: 'Verano'  },
    { id: 'camp_invierno', title: 'Invierno' }
  ];
}

// Botón único “Cotizar”
export function btnCotizar() {
  return [{ id: 'do_quote', title: '🧾 Cotizar' }];
}

// --- Resumen textual listo para pegar ---
export function summaryText(s) {
  return [
    '📝 *Resumen de solicitud*',
    s.name         ? `• Cliente: *${s.name}*` : null,
    s.departamento ? `• Departamento: *${s.departamento}*` : null,
    s.subzona      ? `• Subzona: *${s.subzona}*` : null,
    s.cultivo      ? `• Cultivo: *${s.cultivo}*` : null,
    s.hectareas    ? `• Hectáreas: *${s.hectareas}*` : null,
    s.campana      ? `• Campaña: *${s.campana}*` : null,
    s.items?.length ? `• Ítems: *${s.items.length}*` : null
  ].filter(Boolean).join('\n');
}
