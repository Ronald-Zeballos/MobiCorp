// src/sheets.js
import { config } from '../env.js';

/**
 * Stubs seguros para Google Sheets.
 * Si no hay credenciales/ID, NO rompen: simplemente retornan valores "no-op".
 */

function sheetsDisabled() {
  return !config.SHEETS_SPREADSHEET_ID || !config.GOOGLE_APPLICATION_CREDENTIALS;
}

/**
 * Agrega una fila a la hoja de cotizaciones a partir de la sesión.
 * Retorna true si "haría" el append, false si Sheets está deshabilitado.
 */
export async function sheetsAppendFromSession(s, phone, estado = 'closed') {
  if (sheetsDisabled()) {
    if (config.DEBUG_LOGS) console.log('[SHEETS] disabled: skip appendFromSession');
    return false;
  }
  // Aquí iría la integración real con googleapis.sheets si la activas
  if (config.DEBUG_LOGS) {
    console.log('[SHEETS] appendFromSession (stub)', {
      phone,
      estado,
      name: s?.name,
      departamento: s?.departamento,
      subzona: s?.subzona,
      cultivo: s?.cultivo,
      hectareas: s?.hectareas,
      campana: s?.campana,
      items: (s?.items || []).length
    });
  }
  return true;
}

/**
 * Busca cliente por teléfono (stub). Retorna null si deshabilitado o no encontrado.
 */
export async function getClientByPhone(_phone) {
  if (sheetsDisabled()) {
    if (config.DEBUG_LOGS) console.log('[SHEETS] disabled: skip getClientByPhone');
    return null;
  }
  if (config.DEBUG_LOGS) console.log('[SHEETS] getClientByPhone (stub)');
  return null;
}

/**
 * Inserta/actualiza cliente por teléfono (stub). Retorna true si "ok".
 */
export async function upsertClientByPhone(_phone, _payload) {
  if (sheetsDisabled()) {
    if (config.DEBUG_LOGS) console.log('[SHEETS] disabled: skip upsertClientByPhone');
    return false;
  }
  if (config.DEBUG_LOGS) console.log('[SHEETS] upsertClientByPhone (stub)');
  return true;
}
