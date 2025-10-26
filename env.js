// env.js
import dotenv from 'dotenv';
dotenv.config();

export const config = {
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: process.env.PORT || '10000',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,

  // WhatsApp Cloud API (Meta)
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID,

  // Catálogo/negocio
  CATALOG_URL: process.env.CATALOG_URL,
  STORE_LAT: process.env.STORE_LAT ? Number(process.env.STORE_LAT) : undefined,
  STORE_LNG: process.env.STORE_LNG ? Number(process.env.STORE_LNG) : undefined,
  TIMEZONE: process.env.TIMEZONE || 'America/La_Paz',

  // IA (opcional)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,

  // Google Sheets (opcional)
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  SHEETS_SPREADSHEET_ID: process.env.SHEETS_SPREADSHEET_ID,
  SHEETS_TAB_NAME: process.env.SHEETS_TAB_NAME || 'Hoja 1',
  SHEETS_TAB_CLIENTS_NAME: process.env.SHEETS_TAB_CLIENTS_NAME || 'WA_CLIENTES',
  SHEETS_TAB3_NAME: process.env.SHEETS_TAB3_NAME || 'PRECIOS',
  SHEETS_TAB4_NAME: process.env.SHEETS_TAB4_NAME || 'HIST',

  DEBUG_LOGS: process.env.DEBUG_LOGS === '1',
};
