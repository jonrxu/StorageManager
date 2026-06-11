'use strict';

const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = { provider: 'anthropic', apiKey: '', model: '' };
const DEFAULT_MODELS = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-5.4-mini' };

async function load() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

async function save(partial) {
  const cfg = { ...(await load()) };
  if (typeof partial.provider === 'string' && ['anthropic', 'openai'].includes(partial.provider)) cfg.provider = partial.provider;
  if (typeof partial.model === 'string') cfg.model = partial.model.trim();
  if (typeof partial.apiKey === 'string') cfg.apiKey = partial.apiKey.trim();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    await fs.chmod(FILE, 0o600);
  } catch {}
  return cfg;
}

function publicView(cfg) {
  return {
    provider: cfg.provider,
    model: cfg.model,
    hasKey: Boolean(cfg.apiKey),
    keyHint: cfg.apiKey ? '••••' + cfg.apiKey.slice(-4) : null,
    defaultModels: DEFAULT_MODELS,
  };
}

module.exports = { load, save, publicView, DEFAULT_MODELS };
