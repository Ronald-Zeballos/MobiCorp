// src/aichat.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { config } from '../env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYS_PATH = path.join(__dirname, '..', 'data', 'ai', 'system.json');

let sysPrompt = 'Eres AgroBot (fallback).';
try {
  const raw = fs.readFileSync(SYS_PATH, 'utf8');
  sysPrompt = JSON.parse(raw).system || sysPrompt;
} catch {}

const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export async function chatIA(userText, history = []) {
  const messages = [
    { role: 'system', content: sysPrompt },
    ...history.slice(-6),
    { role: 'user', content: userText }
  ];
  const model = config.OPENAI_MODEL || 'gpt-4o-mini';
  const r = await client.chat.completions.create({
    model,
    temperature: 0.4,
    messages
  });
  return r.choices?.[0]?.message?.content?.trim() || '...';
}
