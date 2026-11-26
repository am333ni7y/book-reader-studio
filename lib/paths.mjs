import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..');

export function isTermux() {
  return Boolean(
    process.env.TERMUX_VERSION ||
      (process.env.PREFIX && process.env.PREFIX.includes('com.termux'))
  );
}

export function loadDotEnv(envPath = path.join(PROJECT_ROOT, '.env')) {
  try {
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!Object.hasOwn(process.env, key)) {
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore unreadable .env
  }
}

export function resolveDataDir(cliDataDir = '') {
  const explicit = String(cliDataDir || process.env.KETABKHAN_DATA_DIR || '').trim();
  if (explicit) return path.resolve(explicit);

  const localData = path.join(PROJECT_ROOT, 'data');
  if (fs.existsSync(path.join(localData, 'library.sqlite'))) {
    return localData;
  }

  if (PROJECT_ROOT.includes(`${path.sep}node_modules${path.sep}`)) {
    return path.join(os.homedir(), '.ketabkhan-studio', 'data');
  }

  return localData;
}

export function resolveObsidianDir(cliNotesDir = '') {
  const explicit = String(cliNotesDir || process.env.OBSIDIAN_NOTES_DIR || '').trim();
  if (explicit) return path.resolve(explicit);

  if (isTermux()) {
    const sharedDocs = path.join(os.homedir(), 'storage', 'shared', 'Documents');
    if (fs.existsSync(sharedDocs)) {
      return path.join(sharedDocs, 'Ketabkhan-Notes');
    }
  }

  return path.join(os.homedir(), 'Documents', 'Ketabkhan-Notes');
}

export function getLanUrls(port, token = '') {
  const nets = os.networkInterfaces();
  const urls = [];
  const suffix = token ? `/?token=${encodeURIComponent(token)}` : '';
  for (const list of Object.values(nets)) {
    if (!Array.isArray(list)) continue;
    for (const info of list) {
      if (info && info.family === 'IPv4' && !info.internal) {
        urls.push(`http://${info.address}:${port}${suffix}`);
      }
    }
  }
  return urls;
}
