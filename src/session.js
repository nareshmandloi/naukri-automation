import { readFile } from 'node:fs/promises';

/**
 * Loads a saved login session, from the NAUKRI_SESSION_B64 secret in CI or
 * session.json locally. Returns null when neither exists.
 */
export async function readSession(sessionFile) {
  const encoded = process.env.NAUKRI_SESSION_B64;
  if (encoded) {
    try {
      return JSON.parse(Buffer.from(encoded.trim(), 'base64').toString('utf8'));
    } catch (err) {
      throw new Error(`NAUKRI_SESSION_B64 is not valid base64 JSON: ${err.message}`);
    }
  }
  try {
    return JSON.parse(await readFile(sessionFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}
