// core/clients.js
import { loadJSON, saveJSON } from './store.js';

const FILE = 'clients.json';

function db() { return loadJSON(FILE, { clients: {} }); }
function commit(data) { saveJSON(FILE, data); }

export function getClient(phone) {
  const data = db();
  return data.clients[phone] || null;
}

export function upsertClient(phone, patch) {
  const data = db();
  const now = new Date().toISOString();
  const prev = data.clients[phone] || {};
  data.clients[phone] = { phone, ...prev, ...patch, lastSeen: now };
  commit(data);
  return data.clients[phone];
}

// (opcional) export default por si en algún lado lo importás como default
export default { getClient, upsertClient };
