import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUniqueResume } from './pdf.js';
import { refreshResume } from './naukri.js';
import { loadEnvFile } from './env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Local convenience; in CI the real environment already holds the secrets.
loadEnvFile(path.join(ROOT, '.env'));
const BASE_RESUME = path.join(ROOT, 'resume', 'base.pdf');
const STATE_FILE = path.join(ROOT, 'state', 'version.json');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts');

const NAME_PREFIX = process.env.RESUME_NAME_PREFIX ?? 'Naresh-Mandloi-Resume-V';
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);

const bool = (value, fallback = false) =>
  value === undefined ? fallback : /^(1|true|yes)$/i.test(value);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Locally: put it in .env. ` +
        `In GitHub Actions: add it under Settings → Secrets and variables → Actions.`,
    );
  }
  return value;
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { version: 5, lastUploadedAt: null, lastUploadedName: null };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dryRun = bool(process.env.DRY_RUN);
  const headless = bool(process.env.HEADLESS, true);

  const email = requireEnv('NAUKRI_EMAIL');
  const password = requireEnv('NAUKRI_PASSWORD');

  // Start clean so a stale screenshot from a previous run is never mistaken
  // for this one's evidence.
  await rm(ARTIFACT_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const state = await readState();
  const nextVersion = Number(state.version) + 1;
  const fileName = `${NAME_PREFIX}${nextVersion}.pdf`;
  const filePath = path.join(ARTIFACT_DIR, fileName);

  console.log(`Naukri resume refresh — ${new Date().toISOString()}`);
  console.log(`  previous version : V${state.version}`);
  console.log(`  uploading as     : ${fileName}`);
  if (dryRun) console.log('  mode             : DRY_RUN (no upload)');

  // resume/ is gitignored because this repo is public, so a fresh clone has
  // no PDF until it is restored from the RESUME_BASE64 secret.
  try {
    await access(BASE_RESUME);
  } catch {
    throw new Error(
      `${path.relative(ROOT, BASE_RESUME)} is missing. Locally: put your resume there. ` +
        'In GitHub Actions: set the RESUME_BASE64 secret (see README > Setup).',
    );
  }

  const { bytes } = await buildUniqueResume(BASE_RESUME, filePath);
  console.log(`  prepared         : ${bytes} bytes (unique marker injected)`);

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`\n--- attempt ${attempt} of ${MAX_ATTEMPTS} ---`);
    try {
      const result = await refreshResume({
        email,
        password,
        filePath,
        fileName,
        artifactDir: ARTIFACT_DIR,
        headless,
        dryRun,
      });

      if (result.dryRun) {
        console.log('\nDRY_RUN complete — version not advanced.');
        return;
      }

      // Only a verified upload advances the counter, so a failed run retries
      // the same version number rather than skipping ahead.
      await writeFile(
        STATE_FILE,
        `${JSON.stringify(
          {
            version: nextVersion,
            lastUploadedAt: new Date().toISOString(),
            lastUploadedName: fileName,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      console.log(`\n✓ Done. Profile resume is now ${fileName}; next run uses V${nextVersion + 1}.`);
      return;
    } catch (err) {
      lastError = err;
      console.error(`✗ attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        const backoff = 20000 * attempt;
        console.log(`  retrying in ${backoff / 1000}s`);
        await sleep(backoff);
      }
    }
  }

  throw new Error(
    `All ${MAX_ATTEMPTS} attempts failed. Last error: ${lastError.message}\n` +
      `Screenshots and DOM dumps are in artifacts/ (uploaded as a workflow artifact in CI).`,
  );
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
});
