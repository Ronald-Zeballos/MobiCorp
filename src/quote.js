import { createQuotePdf } from "./pdf.js";

export async function buildQuote(session, waId) {
  const nombre = session.nombre || "Cliente";
  const tipoCliente = session.tipoCliente || "-";
  const ciudad = session.ciudad || "-";
  const zona = session.zona || "-";
  const tipoEspacio = session.tipoEspacio || "-";
  const servicio = session.tipoServicio || "A definir junto al asesor";

  const ubicacion = [ciudad, zona].filter(Boolean).join(" – ");

  const items = (session.items || []).map((it) => ({
    name: it.name || it.nombre || "-",
    qty: it.qty || 1,
    price: it.price || 0
  }));

  return createQuotePdf({
    clienteNombre: nombre,
    tipoCliente,
    ubicacion,
    tipoEspacio,
    servicio,
    items
  });
}
