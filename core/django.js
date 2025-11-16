// core/django.js
import fetch from "node-fetch";
import { config } from "../env.js";

const BASE = (config.DJANGO_WA_URL || "").replace(/\/+$/, ""); // ej: https://.../api/wa/lead

function log(...args) {
  if (config.DEBUG_LOGS) {
    console.log(...args);
  }
}

/**
 * Envía el carrito al backend para que complete precios/ids de producto.
 * No rompe el flujo si falla: si hay error, deja los precios como estaban.
 */
export async function djangoFillCartPrices(session, waId) {
  if (!BASE) {
    log("[DJANGO] DJANGO_WA_URL no configurada, no lleno precios.");
    return session;
  }

  const url = `${BASE}/cart/preview/`; // 👈 CORRECTO: /api/wa/lead/cart/preview/
  const payload = {
    whatsappId: waId,
    cliente: {
      nombreCompleto: session.nombre || null,
      tipoCliente: session.tipoCliente || null,
      ciudad: session.ciudad || null,
      zona: session.zona || null,
      tipoEspacio: session.tipoEspacio || null
    },
    items: (session.items || []).map((it, idx) => ({
      line: idx + 1,
      skuInterno: it.sku || it.sku_interno || it.SKU || null,
      nombre: it.name || it.nombre || "",
      cantidad: it.qty || 1,
      precioSolicitado: it.price || null
    }))
  };

  log("[DJANGO] Enviando carrito para precios ->", url);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.DJANGO_WA_API_KEY
          ? { Authorization: `Token ${config.DJANGO_WA_API_KEY}` }
          : {})
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      console.error("[DJANGO] preview status", res.status, "body:", text.slice(0, 400));
      return session;
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      console.error("[DJANGO] Respuesta preview no es JSON:", e);
      return session;
    }

    // Forma esperada (defensivo): { items: [{ line, precio, subtotal, idProducto, skuInterno, nombre }], moneda, total }
    if (Array.isArray(data.items)) {
      const byLine = new Map();
      for (const item of data.items) {
        if (item.line != null) {
          byLine.set(Number(item.line), item);
        }
      }

      session.items = (session.items || []).map((it, idx) => {
        const line = idx + 1;
        const upd = byLine.get(line);
        if (!upd) return it;

        const price = upd.precio ?? upd.precioUnitario ?? it.price;
        const subtotal = upd.subtotal ?? (price ? price * (it.qty || 1) : it.subtotal);

        return {
          ...it,
          price: price,
          subtotal: subtotal,
          sku: upd.skuInterno || it.sku || it.sku_interno,
          name: upd.nombre || it.name || it.nombre,
          idProducto: upd.idProducto ?? it.idProducto
        };
      });

      if (data.total != null) {
        session.subtotalPreliminar = Number(data.total);
      }
    }

    return session;
  } catch (err) {
    console.error("[DJANGO] Error preview:", err.message);
    return session;
  }
}

/**
 * Envía la orden final (pedido + cliente) al backend.
 * No corta el flujo si hay error, solo loguea.
 */
export async function djangoSendOrder(session, waId, extras = {}) {
  if (!BASE) {
    log("[DJANGO] DJANGO_WA_URL no configurada, no envío orden.");
    return;
  }

  const url = `${BASE}/orders/`; // 👈 CORRECTO: /api/wa/lead/orders/
  const nowIso = new Date().toISOString();

  const payload = {
    whatsappId: waId,
    cliente: {
      nombreCompleto: session.nombre || null,
      tipoCliente: session.tipoCliente || null,
      ciudad: session.ciudad || null,
      zona: session.zona || null,
      pais: "Bolivia",
      canalOrigen: "whatsapp"
    },
    pedido: {
      montoTotal: session.totalCalculado || session.subtotalPreliminar || null,
      moneda: "BOB",
      fechaCreacion: nowIso,
      estado: "PENDIENTE",
      observaciones: `TipoEspacio: ${session.tipoEspacio || "-"}; Servicio: ${session.tipoServicio || "-"}`,
      urlPdfCotizacion: extras.pdfUrl || null,
      pdfFilename: extras.pdfFilename || null,
      quoteId: extras.quoteId || null
    },
    items: (session.items || []).map((it, idx) => ({
      line: idx + 1,
      idProducto: it.idProducto || null,
      skuInterno: it.sku || it.sku_interno || null,
      nombre: it.name || it.nombre || "",
      cantidad: it.qty || 1,
      precioUnitario: it.price || 0,
      subtotal: it.subtotal || ((it.price || 0) * (it.qty || 1))
    }))
  };

  log("[DJANGO] Enviando orden final ->", url);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.DJANGO_WA_API_KEY
          ? { Authorization: `Token ${config.DJANGO_WA_API_KEY}` }
          : {})
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      console.error("[DJANGO] order status", res.status, "body:", text.slice(0, 400));
      return;
    }

    log("[DJANGO] order OK:", text.slice(0, 200));
  } catch (err) {
    console.error("[DJANGO] Error order:", err.message);
  }
}
