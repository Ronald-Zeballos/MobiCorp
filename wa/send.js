// wa/send.js (extracto: añade si falta)

export function waSendList(to, bodyText, rows = []) {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: "Elegir",
        sections: [{
          title: "Opciones",
          rows: rows.map(r => ({ id: r.id, title: r.title.slice(0, 24) }))
        }]
      }
    }
  };
  if (config.DEBUG_LOGS) console.log("[WA -> list]", to, rows.map(r=>r.id).join(","));
  return enqueue(() => postJSON(url, payload));
}

export function waSendImage(to, mediaId, caption = "") {
  if (!assertCreds()) return Promise.resolve(false);
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { id: mediaId, caption }
  };
  if (config.DEBUG_LOGS) console.log("[WA -> image]", to, caption, mediaId);
  return enqueue(() => postJSON(url, payload));
}
