const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;
const DEFAULT_CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const memory = new Map();
const inflight = new Map();

function boolEnv(name, defaultValue = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return Boolean(defaultValue);
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function intEnv(name, defaultValue, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(process.env[name] || String(defaultValue), 10);
  if (!Number.isFinite(value)) return defaultValue;
  return Math.max(minimum, Math.min(maximum, value));
}

function cacheEnabled() {
  return boolEnv('FLIX_FINDER_CACHE_ENABLED', true);
}

function cacheDir() {
  return String(process.env.FLIX_FINDER_CACHE_DIR || DEFAULT_CACHE_DIR).trim() || DEFAULT_CACHE_DIR;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function cachePath(namespace, keyHash) {
  const safeNamespace = String(namespace || 'default').replace(/[^a-z0-9_.-]/gi, '_');
  return path.join(cacheDir(), safeNamespace, `${keyHash}.json`);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function readFileEntry(namespace, keyHash) {
  try {
    const raw = fs.readFileSync(cachePath(namespace, keyHash), 'utf8');
    const entry = JSON.parse(raw);
    if (!entry || entry.version !== CACHE_VERSION) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeFileEntry(namespace, keyHash, entry) {
  try {
    const filePath = cachePath(namespace, keyHash);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(entry), 'utf8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

function classify(entry) {
  if (!entry) return { entry: null, state: 'miss' };
  const now = nowSeconds();
  if (Number(entry.freshUntil || 0) > now) return { entry, state: 'fresh' };
  if (Number(entry.staleUntil || 0) > now) return { entry, state: 'stale' };
  return { entry: null, state: 'expired' };
}

function getEntry(namespace, keyHash) {
  const cached = classify(memory.get(`${namespace}:${keyHash}`));
  if (cached.state === 'fresh' || cached.state === 'stale') return cached;

  const fileEntry = readFileEntry(namespace, keyHash);
  const fileCached = classify(fileEntry);
  if (fileCached.state === 'fresh' || fileCached.state === 'stale') {
    memory.set(`${namespace}:${keyHash}`, fileEntry);
  }
  return fileCached;
}

function storeEntry(namespace, keyHash, value, ttlSeconds, staleSeconds) {
  const now = nowSeconds();
  const ttl = Math.max(1, Number(ttlSeconds || 1));
  const stale = Math.max(ttl, Number(staleSeconds || ttl));
  const entry = {
    version: CACHE_VERSION,
    createdAt: now,
    freshUntil: now + ttl,
    staleUntil: now + stale,
    value
  };
  memory.set(`${namespace}:${keyHash}`, entry);
  writeFileEntry(namespace, keyHash, entry);
  return entry;
}

async function refresh(namespace, keyHash, producer, options) {
  const inflightKey = `${namespace}:${keyHash}`;
  if (inflight.has(inflightKey)) return inflight.get(inflightKey);

  const task = (async () => {
    const value = await producer();
    const isEmptyArray = Array.isArray(value) && value.length === 0;
    const ttlSeconds = isEmptyArray
      ? Number(options.emptyTtlSeconds || options.ttlSeconds)
      : Number(options.ttlSeconds);
    storeEntry(namespace, keyHash, value, ttlSeconds, Number(options.staleSeconds));
    return value;
  })().finally(() => {
    inflight.delete(inflightKey);
  });

  inflight.set(inflightKey, task);
  return task;
}

async function cacheWrap(namespace, keyParts, producer, options = {}) {
  if (!cacheEnabled()) return producer();

  const keyHash = stableHash(keyParts);
  const cached = getEntry(namespace, keyHash);
  if (cached.state === 'fresh') return cached.entry.value;

  if (cached.state === 'stale') {
    refresh(namespace, keyHash, producer, options).catch(() => undefined);
    return cached.entry.value;
  }

  try {
    return await refresh(namespace, keyHash, producer, options);
  } catch (err) {
    const fallback = getEntry(namespace, keyHash);
    if (fallback.state === 'fresh' || fallback.state === 'stale') return fallback.entry.value;
    throw err;
  }
}

module.exports = {
  cacheWrap,
  intEnv,
  stableHash
};
