import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.js';
import { readSession } from './session.js';
import { openBrowser, assertSignedIn, PROFILE_URL } from './naukri.js';
import { loadResumeProfile, scoreJob, parseExperience } from './skills.js';
import { searchJobs, applyToJob } from './jobs.js';
import { readCandidate, answerQuestionnaire } from './questions.js';
import { sendRunReport, telegramConfigured } from './notify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(path.join(ROOT, '.env'));

const BASE_RESUME = path.join(ROOT, 'resume', 'base.pdf');
const SESSION_FILE = path.join(ROOT, 'session.json');
const CANDIDATE_FILE = path.join(ROOT, 'candidate.json');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts');
const COUNTS_FILE = path.join(ROOT, 'state', 'applies.json');
const UNANSWERED_FILE = path.join(ROOT, 'state', 'unanswered-questions.json');
const HISTORY_URL = 'https://www.naukri.com/myapply/historypage';

const DEFAULT_KEYWORDS = 'Full Stack Developer, GenAI Engineer, Node.js Developer, React Developer';

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tallies screening questions the bot could not answer, so the most frequent
 * ones can be added to the answer bank. Holds only employers' question text —
 * nothing about the user — since the repo is public.
 */
async function recordUnanswered(questions) {
  if (!questions.length) return;
  let log = {};
  try {
    log = JSON.parse(await readFile(UNANSWERED_FILE, 'utf8'));
  } catch {
    // first run, or unreadable — start fresh
  }
  const day = istDay();
  for (const raw of questions) {
    const q = raw.replace(/^(unanswered|stuck):\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const entry = (log[q] ??= { count: 0, firstSeen: day });
    entry.count += 1;
    entry.lastSeen = day;
  }
  const sorted = Object.fromEntries(Object.entries(log).sort((a, b) => b[1].count - a[1].count));
  await writeFile(UNANSWERED_FILE, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

/** Today's date in India, since Naukri's daily limit follows IST days. */
const istDay = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * Application counters, committed to the repo so they survive between runs.
 * Counts only — never which jobs — because the repo is public.
 */
async function readCounts() {
  let c;
  try {
    c = JSON.parse(await readFile(COUNTS_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    c = { total: 0, since: istDay(), day: istDay(), today: 0 };
  }
  if (c.day !== istDay()) Object.assign(c, { day: istDay(), today: 0 });
  return c;
}

async function writeCounts(c) {
  await writeFile(COUNTS_FILE, `${JSON.stringify(c, null, 2)}\n`, 'utf8');
}

/**
 * Naukri's own "Total applies" figure. Read from the JSON the history page
 * loads (matchingRowsCount), which is sturdier than page text, with the
 * rendered "N Total applies" text as a fallback. Logs why when it fails.
 */
async function readNaukriTotal(page) {
  let fromApi = null;
  const onResponse = async (r) => {
    if (!/applyapi\/v\d+\/history\?/.test(r.url())) return;
    try {
      const n = Number((await r.json())?.matchingRowsCount);
      if (Number.isFinite(n)) fromApi = n;
    } catch {
      // not JSON — ignore
    }
  };
  page.on('response', onResponse);
  try {
    await page.goto(HISTORY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (fromApi != null) return fromApi;
      const text = await page.locator('body').innerText().catch(() => '');
      const m = text.match(/(\d[\d,]*)\s*Total\s*applies/i);
      if (m) return Number(m[1].replace(/,/g, ''));
      await page.waitForTimeout(1000);
    }
    console.log(`  Naukri total not found on ${page.url()} — using the last known figure.`);
  } catch (err) {
    console.log(`  Naukri total not read (${err.message.split('\n')[0]}) — using the last known figure.`);
  } finally {
    page.off('response', onResponse);
  }
  return null;
}

async function main() {
  const dryRun = bool(process.env.DRY_RUN);
  const headless = bool(process.env.HEADLESS, true);
  const maxApplications = num(process.env.MAX_APPLICATIONS, 10);
  const dailyLimit = num(process.env.DAILY_LIMIT, 50);
  const minMatched = num(process.env.MIN_MATCHED_SKILLS, 3);
  const minRatio = num(process.env.MIN_MATCH_RATIO, 0.4);
  const locations = process.env.JOB_LOCATIONS || undefined;
  const keywords = (process.env.SEARCH_KEYWORDS || DEFAULT_KEYWORDS)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  // This repo is public, so its Actions logs are too. In CI, jobs are logged
  // by index and score only, not by title and company, unless asked for.
  const showDetails = !process.env.GITHUB_ACTIONS || bool(process.env.LOG_JOB_DETAILS);

  const sessionState = await readSession(SESSION_FILE);
  if (!sessionState) {
    throw new Error(
      'No saved session. Auto-apply only runs on a captured session — run `npm run session` ' +
        '(locally) or set the NAUKRI_SESSION_B64 secret (CI).',
    );
  }

  try {
    await access(BASE_RESUME);
  } catch {
    throw new Error(
      `${path.relative(ROOT, BASE_RESUME)} is missing — it is the source of the skills to match. ` +
        'Locally: put your resume there. In CI: set the RESUME_BASE64 secret.',
    );
  }

  await rm(ARTIFACT_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const profile = await loadResumeProfile(BASE_RESUME);
  const years = num(process.env.YEARS_EXPERIENCE, profile.years);
  if (profile.skills.size === 0) {
    throw new Error('Found no skills in the resume\'s "Technical Skills" section.');
  }

  const candidate = await readCandidate(CANDIDATE_FILE);

  const counts = await readCounts();
  const remainingToday = Math.max(0, dailyLimit - counts.today);
  const runCap = dryRun ? maxApplications : Math.min(maxApplications, remainingToday);

  console.log(`Naukri auto-apply — ${new Date().toISOString()}`);
  console.log(`  resume skills    : ${profile.skills.size}`);
  console.log(`  experience       : ${years ?? 'unknown'} years`);
  console.log(`  keywords         : ${keywords.length}`);
  console.log(`  match threshold  : ≥${minMatched} skills and ≥${Math.round(minRatio * 100)}%`);
  console.log(`  applied today    : ${counts.today} / ${dailyLimit} (IST day ${counts.day})`);
  console.log(`  this run's cap   : ${runCap}`);
  console.log(`  bot total        : ${counts.total} since ${counts.since}`);
  console.log(`  screening Qs     : ${candidate ? 'answered from candidate profile' : 'skipped (no CANDIDATE_PROFILE)'}`);
  if (dryRun) console.log('  mode             : DRY_RUN (no applications sent)');

  if (runCap === 0) {
    console.log(`\nDaily limit of ${dailyLimit} already reached — nothing to do until tomorrow (IST).`);
    return;
  }

  const { browser, context, page } = await openBrowser({ headless, sessionState });
  const appliedJobs = [];
  let reportFailed = false;
  const manualJobs = [];
  const tally = {};
  const unanswered = [];
  let errors = 0;

  // Answers include CTC, so in CI only the rule that fired is logged.
  const logAnswer = (question, answer, chosen) =>
    console.log(`    Q: ${question.slice(0, 90)}\n    A: ${showDetails ? chosen : `(${answer.rule})`}`);
  const answerQuestions = candidate
    ? (p, label) => answerQuestionnaire(p, { candidate, resume: profile, artifactDir: ARTIFACT_DIR, label, log: logAnswer })
    : undefined;

  try {
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await assertSignedIn(page, ARTIFACT_DIR);
    console.log('✓ saved session is valid');

    // Collect and dedupe across keywords.
    const found = new Map();
    for (const keyword of keywords) {
      try {
        const jobs = await searchJobs(page, keyword, { experience: years, locations });
        jobs.forEach((j) => found.set(j.id, j));
        console.log(`→ keyword ${keywords.indexOf(keyword) + 1}: ${jobs.length} jobs from the last day`);
      } catch (err) {
        errors += 1;
        console.log(`✗ keyword ${keywords.indexOf(keyword) + 1} search failed: ${err.message}`);
      }
      await sleep(2000 + Math.random() * 2000);
    }

    const candidates = [...found.values()]
      .map((job) => ({ job, score: scoreJob(job.tags, profile) }))
      .filter(({ job, score }) => {
        if (score.matched.length < minMatched || score.ratio < minRatio) return false;
        const exp = parseExperience(job.experience);
        // Allow a year of stretch either side of the posted range.
        return !exp || years == null || (exp.min <= years + 1 && exp.max >= years - 1);
      })
      .sort((a, b) => b.score.ratio - a.score.ratio || b.score.matched.length - a.score.matched.length);

    console.log(`\n${found.size} unique jobs, ${candidates.length} match the resume\n`);

    let applied = 0;
    for (const [i, { job, score }] of candidates.entries()) {
      if (applied >= runCap) break;

      const label = String(i + 1);
      const name = showDetails ? `${job.title} @ ${job.company}` : `job ${label}`;
      const pct = Math.round(score.ratio * 100);

      let outcome = 'unknown';
      let lastUnanswered = null;
      // One retry covers a transient network or navigation error. It is safe:
      // if the first attempt did submit, the retry sees "Applied" and stops.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          outcome = await applyToJob(page, job, {
            dryRun,
            artifactDir: ARTIFACT_DIR,
            label,
            answerQuestions,
            onUnanswered: (question, status) => {
              unanswered.push(`${status}: ${question}`);
              lastUnanswered = question;
            },
          });
          break;
        } catch (err) {
          console.log(`  attempt ${attempt} on ${name} failed: ${err.message.split('\n')[0]}`);
          if (attempt === 1) await sleep(10000);
        }
      }
      tally[outcome] = (tally[outcome] ?? 0) + 1;

      const skills = showDetails ? ` [${score.matched.join(', ')}]` : '';
      console.log(`${outcome.padEnd(15)} ${pct}% ${score.matched.length}/${score.considered}  ${name}${skills}`);

      const record = { title: job.title, company: job.company, url: job.url, matchPct: pct };
      if (outcome.startsWith('applied') || outcome === 'dry-run') {
        applied += 1;
        appliedJobs.push({
          ...record,
          note: outcome === 'applied+answers' ? 'Answered screening questions' : dryRun ? 'Dry run — not sent' : '',
        });
        if (!dryRun) {
          // Saved after every application, so a crash mid-run keeps the count.
          counts.today += 1;
          counts.total += 1;
          await writeCounts(counts);
        }
      }
      if (outcome === 'needs-answers') manualJobs.push({ ...record, note: lastUnanswered ?? '' });
      if (outcome === 'unknown') errors += 1;
      // Debug aid: stop at the first questionnaire so its handling can be
      // inspected without spending more applications.
      if (bool(process.env.STOP_AFTER_QUESTIONNAIRE) && /answers/.test(outcome)) {
        console.log('STOP_AFTER_QUESTIONNAIRE set — stopping after the first questionnaire.');
        break;
      }
      if (outcome === 'quota') {
        console.log('Naukri reports the daily application quota is used up — stopping.');
        // Stop the remaining runs today from trying.
        counts.today = Math.max(counts.today, dailyLimit);
        await writeCounts(counts);
        break;
      }
      await sleep(4000 + Math.random() * 5000);
    }

    console.log(`\nSummary: ${JSON.stringify(tally)}`);
    console.log(`Applied today: ${counts.today} / ${dailyLimit} · bot total: ${counts.total}`);

    // One Telegram message per run that applied to something (or, on a
    // manual dry run, would have — which doubles as a test of the setup).
    if (appliedJobs.length) {
      const fresh = await readNaukriTotal(page);
      if (fresh != null && !dryRun) {
        counts.naukriTotal = fresh;
        counts.naukriTotalAt = new Date().toISOString();
        await writeCounts(counts);
      }
      const runUrl = process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null;
      try {
        await sendRunReport({
          applied: appliedJobs,
          manual: manualJobs,
          counts: { ...counts, dailyLimit },
          naukriTotal: fresh ?? counts.naukriTotal ?? null,
          naukriTotalStale: fresh == null && counts.naukriTotal != null ? counts.naukriTotalAt : null,
          runUrl,
          dryRun,
        });
      } catch (err) {
        // Fail the run (after everything else is done and saved) so the
        // ❌ alert and GitHub's failure email surface it — a report that
        // silently never arrives is how applications went unseen before.
        console.log(`::error::Telegram report failed: ${err.message}`);
        reportFailed = true;
      }
    }
    if (tally['needs-answers']) {
      console.log(
        `${tally['needs-answers']} job(s) asked questions the tool cannot answer truthfully and ` +
          'were NOT submitted — apply to those manually. Questions it could not handle:',
      );
      // Question text is the employer's, not the user's, so it is safe to log;
      // it is what tells you which rule or skillYears entry to add.
      for (const q of unanswered) console.log(`  - ${q}`);
    }
    await recordUnanswered(unanswered);

    if (reportFailed) process.exitCode = 1;

    // A run that tried and got nothing but errors is a failure worth surfacing;
    // a run that simply found nothing new is not.
    if (errors > 0 && applied === 0) {
      throw new Error(`${errors} error(s) and no successful applications. See artifacts/.`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

/**
 * In CI, a missing Telegram config fails the run (after applying and saving
 * the counter), so GitHub's failure email says so — otherwise reports would
 * silently never arrive.
 */
function assertTelegramInCi() {
  if (process.env.GITHUB_ACTIONS && !telegramConfigured()) {
    console.error(
      '\n::error::Telegram reports are OFF: the TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID ' +
        'repository secrets are missing. Add them under Settings → Secrets and variables → ' +
        'Actions → Repository secrets. (Applications in this run still went through.)',
    );
    process.exitCode = 1;
  }
}

main()
  .then(assertTelegramInCi)
  .catch((err) => {
    console.error(`\nFATAL: ${err.message}`);
    process.exitCode = 1;
    assertTelegramInCi();
  });
