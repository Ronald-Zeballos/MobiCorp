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

  // ===== IA (selector de proveedor) =====
  AI_PROVIDER: process.env.AI_PROVIDER || 'openai',   // 'openai' | 'groq'

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  // Groq
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_MODEL: process.env.GROQ_MODEL || 'llama-3.1-70b-versatile',

  // Parámetros de control IA (opcionales)
  AI_MAX_TOKENS: process.env.AI_MAX_TOKENS,
  AI_MAX_HISTORY: process.env.AI_MAX_HISTORY,
  AI_RETRIES: process.env.AI_RETRIES,
  AI_BASE_DELAY_MS: process.env.AI_BASE_DELAY_MS,

  // Google Sheets (opcional)
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  SHEETS_SPREADSHEET_ID: process.env.SHEETS_SPREADSHEET_ID,
  SHEETS_TAB_NAME: process.env.SHEETS_TAB_NAME || 'Hoja 1',
  SHEETS_TAB_CLIENTS_NAME: process.env.SHEETS_TAB_CLIENTS_NAME || 'WA_CLIENTES',
  SHEETS_TAB3_NAME: process.env.SHEETS_TAB3_NAME || 'PRECIOS',
  SHEETS_TAB4_NAME: process.env.SHEETS_TAB4_NAME || 'HIST',

  DEBUG_LOGS: process.env.DEBUG_LOGS === '1',
};
