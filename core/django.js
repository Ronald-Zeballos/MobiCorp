// core/django.js
import fetch from "node-fetch";
import { config } from "../env.js";

const BASE = (config.DJANGO_WA_URL || "").replace(/\/+$/, "");

function log(...args) {
  if (config.DEBUG_LOGS) {
    console.log(...args);
  }
}

export async function djangoFillCartPrices(session, waId) {
  if (!BASE) {
    log("[DJANGO] DJANGO_WA_URL no configurada, no lleno precios.");
    return session;
  }
  log("[DJANGO] Sin endpoint de preview de carrito, devuelvo sesión sin cambios.");
  return session;
}

export async function djangoSendOrder(session, waId, extras = {}) {
  if (!BASE) {
    log("[DJANGO] DJANGO_WA_URL no configurada, no envío orden.");
    return;
  }

  const nowIso = new Date().toISOString();
  const entitiesBase = `${BASE}/entities`;

  const idCliente =
    session.idCliente ||
    Number(String(Date.now()).slice(-9));

  const clientePayload = {
    idCliente: idCliente,
    nombreCompleto: session.nombre || "",
    email: session.email || "",
    telefono: session.telefono || waId || "",
    zona: session.zona || "",
    ciudad: session.ciudad || session.departamento || "",
    pais: "Bolivia",
    canalOrigen: "whatsapp",
    fechaRegistro: nowIso,
    imageUrl: session.imageUrl || null
  };

  const headers = {
    "Content-Type": "application/json",
    ...(config.DJANGO_WA_API_KEY
      ? { Authorization: `Token ${config.DJANGO_WA_API_KEY}` }
      : {})
  };

  try {
    const urlCliente = `${entitiesBase}/clientes/`;
    log("[DJANGO] Creando/registrando cliente ->", urlCliente);
    const resCli = await fetch(urlCliente, {
      method: "POST",
      headers,
      body: JSON.stringify(clientePayload)
    });
    const textCli = await resCli.text().catch(() => "");
    if (!resCli.ok) {
      console.error("[DJANGO] cliente status", resCli.status, "body:", textCli.slice(0, 400));
    } else {
      log("[DJANGO] cliente OK:", textCli.slice(0, 200));
      session.idCliente = idCliente;
    }
  } catch (err) {
    console.error("[DJANGO] Error creando cliente:", err.message);
  }

  const montoTotal =
    session.totalCalculado ||
    session.subtotalPreliminar ||
    (session.items || []).reduce(
      (acc, it) => acc + ((it.price || 0) * (it.qty || 1)),
      0
    ) ||
    0;

  const idPedido = Number(String(Date.now()).slice(-9));

  const observacionesText = [
    `WA: ${waId || "-"}`,
    `TipoCliente: ${session.tipoCliente || "-"}`,
    `TipoEspacio: ${session.tipoEspacio || "-"}`,
    `Zona: ${session.zona || "-"}`,
    extras.pdfFilename ? `PDF: ${extras.pdfFilename}` : null,
    extras.quoteId ? `QuoteId: ${extras.quoteId}` : null
  ]
    .filter(Boolean)
    .join(" | ");

  const pedidoPayload = {
    idPedido: idPedido,
    idCliente: session.idCliente || idCliente,
    canal: "whatsapp",
    estado: "PENDIENTE",
    montoTotal: montoTotal,
    moneda: "BOB",
    fechaCreacion: nowIso,
    fechaConfirmacion: null,
    urlPdfCotizacion: extras.pdfUrl || null,
    observaciones: observacionesText || "Pedido generado desde bot de WhatsApp"
  };

  try {
    const urlPedido = `${entitiesBase}/pedidos/`;
    log("[DJANGO] Creando pedido ->", urlPedido);
    const resPed = await fetch(urlPedido, {
      method: "POST",
      headers,
      body: JSON.stringify(pedidoPayload)
    });
    const textPed = await resPed.text().catch(() => "");
    if (!resPed.ok) {
      console.error("[DJANGO] pedido status", resPed.status, "body:", textPed.slice(0, 400));
      return;
    }
    log("[DJANGO] pedido OK:", textPed.slice(0, 200));
  } catch (err) {
    console.error("[DJANGO] Error creando pedido:", err.message);
  }
}
