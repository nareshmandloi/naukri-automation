import { firstMatch, capture } from './naukri.js';

const ORIGIN = 'https://www.naukri.com';

// Candidate selectors, most specific first, because Naukri A/B-tests markup.
const SELECTORS = {
  card: ['.srp-jobtuple-wrapper', 'article.jobTuple', '.cust-job-tuple'],
  alreadyApplied: ['#already-applied', 'button:text-is("Applied")', 'span:text-is("Applied")'],
  external: ['#company-site-button', 'button:has-text("Apply on company site")'],
  apply: ['#apply-button', 'button:text-is("Apply")', 'button:text-is("I am interested")'],
  // Employer questionnaires open in a chat-style drawer. They are answered
  // from candidate.json + the resume (src/questions.js) when possible;
  // otherwise the job is left unsubmitted for a manual apply.
  questionnaire: [
    '[class*="chatbot_Drawer"]',
    '[class*="chatbot_MessageContainer"]',
    '.chatbot_DrawerContentWrapper',
  ],
};

/** Builds a Naukri search URL limited to jobs posted in the last day. */
export function searchUrl(keyword, { experience, locations } = {}) {
  const slug = keyword
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const url = new URL(`${ORIGIN}/${slug}-jobs`);
  url.searchParams.set('k', keyword);
  if (locations) url.searchParams.set('l', locations);
  if (experience != null) url.searchParams.set('experience', String(experience));
  url.searchParams.set('jobAge', '1');
  return url.toString();
}

function absolute(href) {
  if (!href) return null;
  return href.startsWith('http') ? href : `${ORIGIN}${href.startsWith('/') ? '' : '/'}${href}`;
}

/** Maps the search API's JSON (which the results page fetches itself) to jobs. */
function parseSearchApi(json) {
  const details = json?.jobDetails;
  if (!Array.isArray(details)) return [];
  return details
    .map((j) => ({
      id: String(j.jobId ?? ''),
      title: j.title ?? '',
      company: j.companyName ?? '',
      url: absolute(j.jdURL),
      tags: String(j.tagsAndSkills ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      experience:
        j.placeholders?.find((p) => p.type === 'experience')?.label ?? j.experienceText ?? '',
    }))
    .filter((j) => j.id && j.url);
}

/** Fallback when the API response was not observed: read the result cards. */
async function scrapeCards(page) {
  return page.evaluate((cardSelectors) => {
    const cards = document.querySelectorAll(cardSelectors.join(','));
    return [...cards]
      .map((card) => {
        const link = card.querySelector('a.title');
        return {
          id: card.getAttribute('data-job-id') || link?.href || '',
          title: link?.textContent?.trim() ?? '',
          company: card.querySelector('.comp-name, a.subTitle')?.textContent?.trim() ?? '',
          url: link?.href ?? null,
          tags: [...card.querySelectorAll('ul.tags-gt li, ul.tags li')].map((li) =>
            li.textContent.trim(),
          ),
          experience:
            card.querySelector('.expwdth, .exp-wrap, li.experience, .exp')?.textContent?.trim() ??
            '',
        };
      })
      .filter((j) => j.url);
  }, SELECTORS.card);
}

/** Returns the jobs posted in the last day for one keyword. */
export async function searchJobs(page, keyword, options) {
  const url = searchUrl(keyword, options);

  // The results page loads its listings from this endpoint. Reading that
  // response is far sturdier than scraping cards, and it carries the full
  // skill list where the cards show a truncated one.
  const apiResponse = page
    .waitForResponse((r) => r.url().includes('/jobapi/v3/search') && r.ok(), { timeout: 30000 })
    .catch(() => null);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const response = await apiResponse;
  let jobs = response ? parseSearchApi(await response.json().catch(() => null)) : [];

  if (!jobs.length && (await firstMatch(page, SELECTORS.card, { timeout: 15000 }))) {
    jobs = await scrapeCards(page);
  }
  return jobs;
}

async function visible(page, candidates) {
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function bodyText(page) {
  return (await page.locator('body').innerText().catch(() => '')).toLowerCase();
}

/**
 * Opens a job and applies if Naukri allows a one-click apply. Returns one of:
 *   applied | applied+answers | already-applied | external | needs-answers |
 *   quota | dry-run | unknown
 */
export async function applyToJob(page, job, { dryRun, artifactDir, label, answerQuestions, onUnanswered }) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait until the page settles into one of the states we understand.
  const deadline = Date.now() + 25000;
  let applyButton = null;
  while (Date.now() < deadline) {
    if (await visible(page, SELECTORS.alreadyApplied)) return 'already-applied';
    if (await visible(page, SELECTORS.external)) return 'external';
    applyButton = await visible(page, SELECTORS.apply);
    if (applyButton) break;
    await page.waitForTimeout(500);
  }
  if (!applyButton) {
    await capture(page, `job-${label}-no-apply-button`, artifactDir);
    return 'unknown';
  }

  if (dryRun) return 'dry-run';

  await applyButton.click();

  let outcomeDeadline = Date.now() + 25000;
  let answeredQuestions = false;
  while (Date.now() < outcomeDeadline) {
    if (/saveapply|apply-confirmation|myapply/i.test(page.url())) {
      return answeredQuestions ? 'applied+answers' : 'applied';
    }
    if (await visible(page, SELECTORS.alreadyApplied)) {
      return answeredQuestions ? 'applied+answers' : 'applied';
    }
    if (await visible(page, SELECTORS.questionnaire)) {
      if (!answerQuestions) return 'needs-answers';
      const result = await answerQuestions(page, label);
      if (result.status !== 'done') {
        onUnanswered?.(result.question, result.status);
        return 'needs-answers';
      }
      answeredQuestions = true;
      // The drawer closed; give Naukri time to confirm the application.
      outcomeDeadline = Date.now() + 25000;
      continue;
    }

    const text = await bodyText(page);
    if (text.includes('successfully applied') || text.includes('applied successfully')) {
      return answeredQuestions ? 'applied+answers' : 'applied';
    }
    if (text.includes('daily quota') || text.includes('reached the maximum')) return 'quota';
    await page.waitForTimeout(500);
  }

  await capture(page, `job-${label}-unconfirmed`, artifactDir);
  return 'unknown';
}
