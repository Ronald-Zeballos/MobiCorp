// src/quote.js
import { createQuotePdf } from "./pdf.js";

/**
 * buildQuote(session, phone)
 * Usa los datos de la sesión para crear un PDF de cotización Mobicorp.
 * Devuelve: { path, filename }
 */
export async function buildQuote(session, phone) {
  const {
    nombre,
    tipoCliente,
    ciudad,
    zona,
    tipoEspacio,
    tipoServicio,
    items
  } = session || {};

  const { path, filename } = await createQuotePdf({
    name: nombre || phone,
    tipoCliente: tipoCliente || "-",
    ciudad: ciudad || "-",
    zona: zona || "-",
    tipoEspacio: tipoEspacio || "-",
    tipoServicio: tipoServicio || "-",
    items: items || []
  });

  return { path, filename };
}
