import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, 'memory');
const STORE_PATH = join(MEMORY_DIR, 'store.json');
mkdirSync(MEMORY_DIR, { recursive: true });

const client = new Anthropic();

// ── Persistence ────────────────────────────────────────────────────────────

function load() {
  if (!existsSync(STORE_PATH)) return { entries: [] };
  try { return JSON.parse(readFileSync(STORE_PATH, 'utf8')); }
  catch { return { entries: [] }; }
}

function persist(store) {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

// ── Metadata extraction (Claude Haiku) ─────────────────────────────────────
// Called once on save — generates rich searchable fields from raw content.

async function extractMeta(type, content) {
  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `You are a QA metadata extractor. Analyse this ${type} and return ONLY a JSON object (no markdown fences):
{
  "title":    "short descriptive title, max 70 chars",
  "summary":  "2-3 sentence summary of what was tested and key findings",
  "appName":  "name of the application being tested, or null",
  "domain":   "industry domain, e.g. e-commerce, fintech, healthcare, saas, devtools",
  "keywords": ["8 to 15 highly relevant search keywords — app name, features, tech stack, test types, risk areas"]
}

Content (first 3 000 chars):
${content.slice(0, 3000)}`,
      }],
    });
    return JSON.parse(res.content[0].text.trim());
  } catch {
    return {
      title:    `${type} — ${new Date().toLocaleDateString()}`,
      summary:  content.slice(0, 150),
      appName:  null,
      domain:   'unknown',
      keywords: [],
    };
  }
}

// ── Retrieval scoring (keyword overlap + field-weight boosts) ──────────────

function score(entry, queryTokens) {
  if (!queryTokens.length) return 0;
  const haystack = [
    entry.title,
    entry.summary,
    ...(entry.keywords   ?? []),
    entry.metadata?.appName ?? '',
    entry.metadata?.domain  ?? '',
  ].join(' ').toLowerCase();

  let s = 0;
  for (const tok of queryTokens) {
    if (haystack.includes(tok))                                                     s += 1;
    if (entry.title?.toLowerCase().includes(tok))                                   s += 2;   // title bonus
    if ((entry.keywords ?? []).some(k => k.toLowerCase().includes(tok)))            s += 1.5; // keyword bonus
    if (entry.metadata?.appName?.toLowerCase().includes(tok))                       s += 2;   // app-name bonus
  }
  return s;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Save a new memory entry.
 * type: 'exploration' | 'test_plan' | 'test_suite'
 * content: raw text (plan, findings, or test-case summary)
 * metadata: arbitrary extra fields (appName, url, testCount, categories …)
 */
export async function saveMemory({ type, content, metadata = {} }) {
  const meta  = await extractMeta(type, content);
  const entry = {
    id:        `mem_${Date.now()}`,
    type,
    timestamp: new Date().toISOString(),
    title:     meta.title,
    summary:   meta.summary,
    keywords:  meta.keywords,
    content:   content.slice(0, 50000),
    metadata:  { appName: meta.appName, domain: meta.domain, ...metadata },
  };
  const store = load();
  store.entries.unshift(entry);   // most-recent first
  persist(store);
  return entry;
}

/**
 * Semantic keyword search. Returns entries scored by relevance, most relevant first.
 * Strips the heavy `content` field from results (callers use getMemory for full content).
 */
export function searchMemory(query, { limit = 5, type = null } = {}) {
  const tokens = query.toLowerCase().split(/\W+/).filter(t => t.length >= 3);
  let   entries = load().entries;
  if (type) entries = entries.filter(e => e.type === type);

  return entries
    .map(e => ({ ...e, _score: score(e, tokens) }))
    .filter(e => e._score > 0)
    .sort((a, b) => b._score - a._score || new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit)
    .map(({ content: _c, ...rest }) => rest);
}

/** List all entries without the heavy content field. */
export function listMemories({ type = null, limit = 100 } = {}) {
  let entries = load().entries;
  if (type) entries = entries.filter(e => e.type === type);
  return entries.slice(0, limit).map(({ content: _c, ...r }) => r);
}

/** Fetch a single entry including full content (for context injection). */
export function getMemory(id) {
  return load().entries.find(e => e.id === id) ?? null;
}

/** Permanently remove an entry. Returns true if something was deleted. */
export function deleteMemory(id) {
  const store = load();
  const before = store.entries.length;
  store.entries = store.entries.filter(e => e.id !== id);
  persist(store);
  return store.entries.length < before;
}

/** Quick aggregate counts for the UI badge. */
export function memoryStats() {
  const entries = load().entries;
  return {
    total:      entries.length,
    exploration: entries.filter(e => e.type === 'exploration').length,
    test_plan:  entries.filter(e => e.type === 'test_plan').length,
    test_suite: entries.filter(e => e.type === 'test_suite').length,
  };
}
