// src/quote.js
import { createQuotePdf } from './pdf.js';

/**
 * buildQuote(session, phone)
 * Usa los datos de la sesión para crear un PDF de cotización.
 * Devuelve: { path, filename }
 */
export async function buildQuote(session, phone) {
  const ubic = [session.departamento, session.subzona].filter(Boolean).join(' / ');
  const { path, filename } = await createQuotePdf({
    name: session.name || phone,
    ubicacion: ubic || '-',
    cultivo: session.cultivo || '-',
    hectareas: session.hectareas ?? '-',
    campana: session.campana || '-',
    items: session.items || []
  });
  return { path, filename };
}
