import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.js';
import { captureSession } from './naukri.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(path.join(ROOT, '.env'));

const SESSION_FILE = path.join(ROOT, 'session.json');

const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));

async function main() {
  for (const name of ['NAUKRI_EMAIL', 'NAUKRI_PASSWORD']) {
    if (!process.env[name]) throw new Error(`${name} is not set — fill in .env first.`);
  }

  console.log('Capturing a Naukri session from this machine...');
  const state = await captureSession({
    email: process.env.NAUKRI_EMAIL,
    password: process.env.NAUKRI_PASSWORD,
    artifactDir: path.join(ROOT, 'artifacts'),
    headless: bool(process.env.HEADLESS, true),
  });

  const json = JSON.stringify(state);
  await writeFile(SESSION_FILE, json, 'utf8');

  const b64 = Buffer.from(json, 'utf8').toString('base64');
  await mkdir(path.join(ROOT, 'artifacts'), { recursive: true });
  const b64File = path.join(ROOT, 'session.b64');
  await writeFile(b64File, b64, 'utf8');

  const expiries = state.cookies
    .map((c) => c.expires)
    .filter((e) => e && e > 0)
    .sort((a, b) => a - b);
  const soonest = expiries.length ? new Date(expiries[0] * 1000) : null;

  console.log(`\n✓ Saved ${state.cookies.length} cookies to session.json (gitignored)`);
  console.log(`✓ Base64 for the secret written to session.b64 (${b64.length} chars)`);
  if (soonest) console.log(`  earliest cookie expiry: ${soonest.toISOString().slice(0, 10)}`);
  console.log('\nNext: put the contents of session.b64 in the NAUKRI_SESSION_B64 secret.');
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
});
