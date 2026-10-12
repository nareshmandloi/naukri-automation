import { readFileSync } from 'node:fs';

/**
 * Loads KEY=VALUE pairs from a .env file for local runs. Hand-rolled rather
 * than depending on a Node version that has `process.loadEnvFile`, and on
 * dotenv, which would be the only runtime dependency we don't otherwise need.
 *
 * Real environment variables always win, so GitHub Actions secrets are never
 * shadowed by a stray committed file.
 */
export function loadEnvFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }

  let loaded = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Strip one matching pair of surrounding quotes, if present.
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return loaded;
}
