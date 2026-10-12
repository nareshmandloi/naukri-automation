import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOGIN_URL = 'https://www.naukri.com/nlogin/login';
const PROFILE_URL = 'https://www.naukri.com/mnjuser/profile';

// Naukri's markup shifts between A/B buckets, so every interactive element is
// looked up through an ordered candidate list and the first hit wins.
const SELECTORS = {
  email: ['#usernameField', 'input[placeholder*="Email" i]', 'input[type="email"]'],
  password: ['#passwordField', 'input[placeholder*="Password" i]', 'input[type="password"]'],
  // The form also carries a "Use OTP to Login" submit button, which a loose
  // text match would happily click. Match the exact label first.
  submit: [
    'button[type="submit"]:text-is("Login")',
    'form button[type="submit"]',
    'button[type="submit"]',
  ],
  fileInput: ['input#attachCV', 'input[type="file"][name*="cv" i]', 'input[type="file"]'],
  loggedIn: ['.nI-gNb-drawer__bars', '.view-profile-wrapper', 'a[href*="/mnjuser/profile"]'],
};

/** Returns the first selector in `candidates` that is attached to the page. */
async function firstMatch(page, candidates, { timeout = 20000 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    for (const selector of candidates) {
      const locator = page.locator(selector).first();
      if (await locator.count().catch(() => 0)) return locator;
    }
    await page.waitForTimeout(500);
  } while (Date.now() < deadline);
  return null;
}

/**
 * Saves a screenshot plus the raw DOM so a failure can be diagnosed after the
 * fact — the usual causes are a captcha or OTP wall, which are invisible in
 * logs but obvious in the screenshot.
 */
async function capture(page, label, artifactDir) {
  try {
    await mkdir(artifactDir, { recursive: true });
    const stem = path.join(artifactDir, label);
    await page.screenshot({ path: `${stem}.png`, fullPage: true });
    await writeFile(`${stem}.html`, await page.content(), 'utf8');
    console.log(`  [debug] captured ${label}.png and ${label}.html`);
  } catch (err) {
    console.log(`  [debug] capture "${label}" failed: ${err.message}`);
  }
}

/**
 * Explains why an expected element is missing. Only called once the element
 * has already failed to appear, so these phrases never have to compete with
 * legitimate page copy — note that a bare "otp" would match the login form's
 * own "Use OTP to Login" button, hence the longer phrases.
 */
async function diagnoseBlock(page, status) {
  if (status && status >= 400) return `HTTP ${status} from Naukri's edge (bot protection)`;

  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  const signals = [
    ['access denied', 'an "Access Denied" page (Akamai bot protection)'],
    ['captcha', 'a captcha challenge'],
    ['unusual activity', 'an "unusual activity" block'],
    ['too many attempts', 'a rate limit'],
    ['enter otp', 'an OTP prompt'],
    ['otp sent', 'an OTP prompt'],
    ['verify your identity', 'an identity-verification wall'],
  ];
  for (const [needle, description] of signals) {
    if (body.includes(needle)) return description;
  }
  return null;
}

async function login(page, { email, password, artifactDir }) {
  console.log('→ opening login page');
  const response = await page.goto(LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  const status = response?.status();

  const emailField = await firstMatch(page, SELECTORS.email);
  if (!emailField) {
    const reason = (await diagnoseBlock(page, status)) ?? 'the login form never rendered';
    await capture(page, 'login-blocked', artifactDir);
    throw new Error(`Could not reach the login form — Naukri served ${reason}`);
  }

  await emailField.fill(email);
  const passwordField = await firstMatch(page, SELECTORS.password);
  if (!passwordField) throw new Error('Found the email field but not the password field');
  await passwordField.fill(password);

  console.log('→ submitting credentials');
  const submit = await firstMatch(page, SELECTORS.submit);
  if (!submit) throw new Error('Could not find the Login button');
  await submit.click();

  // A successful login leaves /nlogin/; a failed one stays put with an inline
  // error. Wait on the URL change rather than a fixed sleep.
  try {
    await page.waitForURL((url) => !url.pathname.includes('/nlogin/'), { timeout: 45000 });
  } catch {
    const reason = (await diagnoseBlock(page)) ?? 'the credentials were rejected';
    await capture(page, 'login-failed', artifactDir);
    throw new Error(`Login did not complete — Naukri showed ${reason}`);
  }

  if (!(await firstMatch(page, SELECTORS.loggedIn, { timeout: 30000 }))) {
    await capture(page, 'login-unconfirmed', artifactDir);
    throw new Error('Left the login page but the signed-in dashboard never rendered');
  }
  console.log('✓ logged in');
}

async function uploadResume(page, { filePath, fileName, artifactDir, dryRun }) {
  console.log('→ opening profile page');
  const response = await page.goto(PROFILE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  const input = await firstMatch(page, SELECTORS.fileInput, { timeout: 30000 });
  if (!input) {
    const reason =
      (await diagnoseBlock(page, response?.status())) ?? 'no file-upload field was found';
    await capture(page, 'profile-no-upload-field', artifactDir);
    throw new Error(`Could not reach the resume upload control — ${reason}`);
  }

  if (dryRun) {
    console.log(`✓ DRY_RUN: upload field located, skipping upload of ${fileName}`);
    return { verified: false, dryRun: true };
  }

  console.log(`→ uploading ${fileName}`);
  await input.setInputFiles(filePath);

  // Naukri uploads on change. The toast is the first signal but is
  // short-lived, so the reload-and-read below is the check we actually trust.
  const sawToast = await page
    .getByText(/success|uploaded/i)
    .first()
    .waitFor({ timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  console.log(sawToast ? '✓ Naukri reported success' : '! no success toast — verifying by reload');

  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

  const stem = fileName.replace(/\.pdf$/i, '');
  const shown = await page
    .getByText(stem, { exact: false })
    .first()
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);

  if (!shown) {
    await capture(page, 'upload-unverified', artifactDir);
    throw new Error(
      `Upload not confirmed: the profile does not show "${stem}" after reload. ` +
        'See the captured screenshot.',
    );
  }

  console.log(`✓ profile now shows ${fileName}`);
  return { verified: true, dryRun: false };
}

/**
 * Headless Chromium advertises "HeadlessChrome" in its user agent, which is a
 * giveaway, so it has to be overridden. Deriving the override from the
 * browser's own UA — rather than hardcoding one — keeps it consistent with
 * navigator.platform on whatever OS the job runs on (macOS locally, Linux on
 * a CI runner) and keeps the Chrome version in step with the installed build.
 */
async function realisticUserAgent(browser) {
  const probe = await browser.newContext();
  try {
    const page = await probe.newPage();
    const native = await page.evaluate(() => navigator.userAgent);
    return native.replace('HeadlessChrome/', 'Chrome/');
  } finally {
    await probe.close();
  }
}

/** Logs in and replaces the profile resume. Throws on any unverified outcome. */
export async function refreshResume({
  email,
  password,
  filePath,
  fileName,
  artifactDir,
  headless = true,
  dryRun = false,
}) {
  const browser = await chromium.launch({
    headless,
    // Must be the full Chromium build, NOT Playwright's default
    // chromium-headless-shell: Naukri's Akamai edge 403s the shell outright,
    // while this passes. Verified against the live site.
    channel: 'chromium',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    userAgent: await realisticUserAgent(browser),
  });

  // Strip the clearest automation tell before any page script runs.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await login(page, { email, password, artifactDir });
    return await uploadResume(page, { filePath, fileName, artifactDir, dryRun });
  } finally {
    await context.close();
    await browser.close();
  }
}
