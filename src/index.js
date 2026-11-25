import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUniqueResume } from './pdf.js';
import { refreshResume } from './naukri.js';
import { loadEnvFile } from './env.js';
import { readSession } from './session.js';
import { sendTelegram, telegramConfigured, totalsLine } from './notify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Local convenience; in CI the real environment already holds the secrets.
loadEnvFile(path.join(ROOT, '.env'));
const BASE_RESUME = path.join(ROOT, 'resume', 'base.pdf');
const STATE_FILE = path.join(ROOT, 'state', 'version.json');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts');

const SESSION_FILE = path.join(ROOT, 'session.json');
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

/**
 * Daily check-in on Telegram after the resume upload: the new version plus
 * the auto-apply counters. It arrives once a day, so its absence is itself
 * the signal that something is wrong. Never fails the refresh.
 */
async function sendCheckIn(fileName, dryRun) {
  if (!telegramConfigured()) {
    if (process.env.GITHUB_ACTIONS) {
      console.log('::warning::Telegram check-in not sent — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secrets missing.');
    }
    return;
  }
  let counts = null;
  try {
    counts = JSON.parse(await readFile(path.join(ROOT, 'state', 'applies.json'), 'utf8'));
  } catch {
    // No counter yet — the check-in still reports the upload.
  }
  const istToday = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const today = counts && counts.day === istToday ? counts.today : 0;
  const lines = [
    dryRun ? '🧪 <b>[DRY RUN]</b> resume refresh check passed' : `📄 Resume refreshed: <b>${fileName}</b>`,
    counts
      ? totalsLine({ ...counts, today, naukriTotalStale: counts.naukriTotalAt ?? null })
      : '📊 Auto-apply: no applications recorded yet',
    '<i>Daily check-in. If this stops arriving, the automation needs attention.</i>',
  ];
  try {
    await sendTelegram(lines.join('\n'));
    console.log('✓ Telegram check-in sent');
  } catch (err) {
    console.log(`::warning::Telegram check-in failed: ${err.message}`);
  }
}

async function main() {
  const dryRun = bool(process.env.DRY_RUN);
  const headless = bool(process.env.HEADLESS, true);

  const sessionState = await readSession(SESSION_FILE);

  // Credentials are only needed for the password-login path; with a saved
  // session they are not required at all.
  const email = sessionState ? process.env.NAUKRI_EMAIL : requireEnv('NAUKRI_EMAIL');
  const password = sessionState ? process.env.NAUKRI_PASSWORD : requireEnv('NAUKRI_PASSWORD');

  // Start clean so a stale screenshot from a previous run is never mistaken
  // for this one's evidence.
  await rm(ARTIFACT_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const state = await readState();

  // The workflow is scheduled at several backup times because GitHub drops
  // or delays scheduled runs. The first one that runs uploads; the rest see
  // today's upload (in IST) and stop. Manual and local runs always upload.
  if (bool(process.env.ONCE_PER_DAY) && state.lastUploadedAt) {
    const ist = (d) => new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    if (ist(state.lastUploadedAt) === ist(Date.now())) {
      console.log(`Already uploaded today (${state.lastUploadedName} at ${state.lastUploadedAt}) — skipping.`);
      return;
    }
  }

  const nextVersion = Number(state.version) + 1;
  const fileName = `${NAME_PREFIX}${nextVersion}.pdf`;
  const filePath = path.join(ARTIFACT_DIR, fileName);

  console.log(`Naukri resume refresh — ${new Date().toISOString()}`);
  console.log(`  previous version : V${state.version}`);
  console.log(`  uploading as     : ${fileName}`);
  console.log(`  auth             : ${sessionState ? 'saved session' : 'email + password'}`);
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
        sessionState,
        filePath,
        fileName,
        artifactDir: ARTIFACT_DIR,
        headless,
        dryRun,
      });

      if (result.dryRun) {
        console.log('\nDRY_RUN complete — version not advanced.');
        await sendCheckIn(fileName, true);
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
      await sendCheckIn(fileName, false);
      return;
    } catch (err) {
      lastError = err;
      console.error(`✗ attempt ${attempt} failed: ${err.message}`);
      if (err.permanent) {
        throw new Error(`${err.message}\n(Not retried — retrying cannot change this outcome.)`);
      }
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
