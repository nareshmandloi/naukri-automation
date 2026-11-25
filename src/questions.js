import { readFile } from 'node:fs/promises';
import { normalize } from './skills.js';
import { capture } from './naukri.js';

/**
 * Loads the screening-question answers, from the CANDIDATE_PROFILE secret
 * (raw JSON or base64 of it) in CI or candidate.json locally. Returns null
 * when neither exists, which disables answering: jobs with questions are then
 * skipped, as before.
 */
export async function readCandidate(file) {
  const raw = process.env.CANDIDATE_PROFILE?.trim();
  if (raw) {
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    try {
      return JSON.parse(json);
    } catch (err) {
      throw new Error(`CANDIDATE_PROFILE is not valid JSON (or base64 JSON): ${err.message}`);
    }
  }
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deciding an answer. Pure functions, no browser, so they can be unit-tested.
// ---------------------------------------------------------------------------

/** Words that, after "experience in …", mean overall rather than one skill. */
const GENERIC_SUBJECT =
  /^(it|total|overall|relevant|software|the (it|software) industry|industry|this (role|field|domain)|similar roles?|professional|work|working)?$/;

/**
 * Finds the subject of "experience in/with/on X", then maps it to a skill the
 * resume knows. Returns { generic: true } for "total experience", the skill
 * names for a known subject, or null for a subject we know nothing about.
 */
function experienceSubject(question, resume, candidate) {
  const m = question.match(
    /(?:experience|exposure|knowledge|expertise|work(?:ed|ing)?)\s+(?:do you have\s+)?(?:in|with|on|of|using)\s+(.+?)(?:\?|$|\s+(?:do you|you have|in years|years))/i,
  );
  const subject = normalize(
    (m?.[1] ?? '').replace(/\b(the|a|an|years?|of|hands on|hands-on)\b/gi, ' '),
  );
  if (!m || GENERIC_SUBJECT.test(subject)) return { generic: true };

  const known = new Set([
    ...resume.skills,
    ...Object.keys(resume.skillYears),
    ...Object.keys(candidate.skillYears ?? {}).map(normalize),
  ]);
  const padded = ` ${subject} `;
  const skills = [...known].filter((s) => padded.includes(` ${s} `));
  return skills.length ? { skills } : null;
}

/**
 * Years to claim for the given skills. Starts from an explicit `skillYears`
 * entry, else the figure derived from the resume's roles. When
 * `skillYearsRange: [min, max]` is set, every resume skill is answered within
 * it: figures are clamped into the range, and a skill the resume lists but no
 * role mentions gets the minimum. Without the range such a skill has no
 * figure and the question is skipped.
 */
function yearsFor(skills, resume, candidate) {
  const overrides = Object.fromEntries(
    Object.entries(candidate.skillYears ?? {}).map(([k, v]) => [normalize(k), Number(v)]),
  );
  const [lo, hi] = Array.isArray(candidate.skillYearsRange)
    ? candidate.skillYearsRange.map(Number)
    : [undefined, undefined];

  const values = skills.map((s) => {
    let v = overrides[s] ?? resume.skillYears[s];
    if (lo === undefined) return v;
    if (v === undefined || Number.isNaN(v)) v = lo;
    return Math.min(hi, Math.max(lo, v));
  });
  if (values.some((v) => v === undefined || Number.isNaN(v))) return null;
  return Math.min(...values);
}

/** CTC in the unit the question asks for. Lakhs per annum unless told otherwise. */
function ctcAnswer(lpa, question) {
  const q = question.toLowerCase();
  if (/lakh|lac\b|lpa/.test(q)) return { text: String(lpa), number: lpa };
  if (/per month|monthly/.test(q)) {
    const monthly = Math.round((lpa * 100000) / 12);
    return { text: String(monthly), number: monthly };
  }
  if (/\b(inr|rs\.?|rupees)\b|₹|in numbers|absolute/.test(q)) {
    return { text: String(lpa * 100000), number: lpa * 100000 };
  }
  return { text: String(lpa), number: lpa };
}

const yes = (rule) => ({ rule, bool: true, text: 'Yes' });
const no = (rule) => ({ rule, bool: false, text: 'No' });

/**
 * Picks an answer for one screening question, or returns null when the
 * question is not one we can answer truthfully from candidate.json and the
 * resume. Order matters: exclusions are checked before the broad rules.
 */
/**
 * Looks the question up in candidate.json's `answerBank`: answers the user
 * wrote or approved for questions the rules can't derive (reason for change,
 * bond, shifts, APIs built, …). Each entry has regex `match` strings, the
 * `answer` text, optional `options` keywords to pick in a multiple-choice
 * question (in priority order), and an optional `number` for "how many".
 */
/**
 * Expands {{date+N}} in an answer to the date N days from today (IST), e.g.
 * "25 Dec 2026", so a last-working-day answer stays current every day.
 */
export function fillDates(text, now = new Date()) {
  return String(text ?? '').replace(/\{\{date\+(\d+)\}\}/g, (_, n) => {
    const ist = new Date(now.getTime() + 5.5 * 3600 * 1000 + Number(n) * 86400 * 1000);
    return ist.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  });
}

export function decideFromBank(rawQuestion, candidate) {
  const q = rawQuestion.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const entry of candidate.answerBank ?? []) {
    const hit = (entry.match ?? []).some((pattern) => {
      try {
        return new RegExp(pattern, 'i').test(q);
      } catch {
        return false; // a malformed pattern in candidate.json must not crash a run
      }
    });
    if (!hit) continue;
    const wantsNumber = entry.number != null && /how many|number of|size|count/.test(q);
    return {
      rule: `bank:${entry.id ?? 'entry'}`,
      text: wantsNumber ? String(entry.number) : fillDates(entry.answer),
      ...(entry.number != null ? { number: entry.number } : {}),
      prefer: entry.options ?? [],
    };
  }
  return null;
}

function decideSingle(rawQuestion, context) {
  // Rules first: they compute answers (years, CTC units, notice options).
  // The bank covers what rules can't — including questions the rules
  // deliberately refuse to guess (e.g. buyout), when the user answered them.
  return decideByRules(rawQuestion, context) ?? decideFromBank(rawQuestion, context.candidate);
}

export function decideAnswer(rawQuestion, context) {
  // "How many years in React? Have you worked on X?" is two questions in one
  // message. Answering only the first would leave the second silently
  // unanswered, so each part must be answerable or the whole is skipped.
  const parts = rawQuestion
    .split(/(?<=\?)\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 3);
  if (parts.length > 1) {
    const answers = parts.map((p) => decideSingle(p, context));
    if (answers.some((a) => !a)) return null;
    return {
      rule: answers.map((a) => a.rule).join(' & '),
      text: answers.map((a) => a.text.trim().replace(/[.。]+$/, '')).join('. ') + '.',
    };
  }
  return decideSingle(rawQuestion, context);
}

function decideByRules(rawQuestion, { candidate, resume }) {
  const q = rawQuestion.toLowerCase().replace(/\s+/g, ' ').trim();
  const totalYears = resume.years;

  // Things we were never told — never guess these.
  if (/buy ?out|buyout|negotiable|serving (your )?notice|last working day|lwd\b/.test(q)) return null;

  if (/expected (ctc|salary|compensation|package|pay)|salary expectation|expectations? (on|for) (ctc|salary)/.test(q)) {
    return { rule: 'expected-ctc', ...ctcAnswer(candidate.expectedCtcLpa, q) };
  }
  if (/(current|present|existing|last drawn|fixed) (annual )?(ctc|salary|compensation|package|pay)|\bctc\b(?!.*expect)/.test(q)) {
    return { rule: 'current-ctc', ...ctcAnswer(candidate.currentCtcLpa, q) };
  }

  if (/immediate(ly)? (joiner|joining|join|available)|join immediately/.test(q)) {
    return candidate.noticePeriodDays === 0 ? yes('immediate-joiner') : no('immediate-joiner');
  }
  if (/notice period|how soon can you join|earliest (joining|start)|when can you (join|start)|joining (time|period)|available to join/.test(q)) {
    const d = candidate.noticePeriodDays;
    return { rule: 'notice-period', number: d, days: d, text: /days?|number/.test(q) ? String(d) : `${d} days` };
  }

  if (/relocat|willing to (move|shift)|open to (move|moving|shift)/.test(q)) {
    return candidate.willingToRelocate ? yes('relocate') : no('relocate');
  }
  if (/remote|hybrid|on-?site|work from office|\bwfo\b|in-?office|office \d|days? (a|per) week|from (the )?office/.test(q)) {
    return candidate.workModes?.length ? yes('work-mode') : null;
  }
  if (/(comfortable|okay|ok|fine|willing|able) (with |to )?(work|working|join|joining|commute)\b.*\b(from|in|at|location)\b/.test(q)) {
    return candidate.willingToRelocate ? yes('work-location') : null;
  }
  if (/(current|present) (location|city)|where are you (currently )?(based|located|staying|residing)|which city (are you|do you)|your location/.test(q)) {
    return { rule: 'current-city', text: candidate.currentCity };
  }

  if (/(highest|educational) qualification|which degree|what is your (degree|education)/.test(q)) {
    return { rule: 'qualification', text: candidate.highestQualification };
  }
  if (/\b(bachelor'?s?|graduat\w*|b\.? ?e\b|b\.? ?tech|engineering degree|degree in computer)/.test(q) && /^(do|are|have|did|is)\b/.test(q)) {
    return yes('degree');
  }

  // "How many years of experience (in X)?"
  if (/years?|how (long|much experience)|how many/.test(q) && /experience|worked|working/.test(q)) {
    const subject = experienceSubject(q, resume, candidate);
    if (!subject) return null;
    const years = subject.generic ? totalYears : yearsFor(subject.skills, resume, candidate);
    if (years == null) return null;
    return { rule: subject.generic ? 'total-years' : `years:${subject.skills.join('+')}`, number: years, text: String(years > 0 ? Math.max(1, Math.floor(years)) : 0) };
  }

  // "Do you have experience in X?" / "Have you worked on X?"
  if (/^(do|have|are|did)\b/.test(q) && /experience|exposure|knowledge|worked|familiar|hands/.test(q)) {
    const subject = experienceSubject(q, resume, candidate);
    if (!subject) return null;
    return yes(subject.generic ? 'has-experience' : `has:${subject.skills.join('+')}`);
  }

  return null;
}

/** Parses "3-5 years", "30-40 LPA", "5+ years", "Less than 2" into a range. */
function rangeOf(label) {
  const t = label.toLowerCase().replace(/,/g, '');
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)/);
  if (m) return [Number(m[1]), Number(m[2])];
  m = t.match(/(\d+(?:\.\d+)?)\s*\+|(?:more than|above|over|greater than|at least)\s*(\d+(?:\.\d+)?)/);
  if (m) return [Number(m[1] ?? m[2]), Infinity];
  m = t.match(/(?:less than|below|under|upto|up to|within)\s*(\d+(?:\.\d+)?)/);
  if (m) return [-Infinity, Number(m[1])];
  m = t.match(/^\D*(\d+(?:\.\d+)?)\D*$/);
  if (m) return [Number(m[1]), Number(m[1])];
  return null;
}

/** Converts a notice-period option ("1 Month", "15 days or less") to days. */
function optionDays(label) {
  const t = label.toLowerCase();
  if (/immediate|serving/.test(t)) return [0, 0];
  const r = rangeOf(t);
  if (!r) return null;
  const k = /month/.test(t) ? 30 : 1;
  return [r[0] * k, r[1] * k];
}

/**
 * Picks which of the offered options matches the answer. Returns its index,
 * or -1 when none fits, in which case the job is left for manual apply.
 */
export function chooseOption(answer, options) {
  const labels = options.map((o) => o.toLowerCase().trim());

  // Answer-bank entries name which option to pick, in priority order. A
  // numeric entry (team size) tries the range options ("5-10") first.
  if (answer.prefer) {
    if (answer.number !== undefined) {
      const byRange = labels.findIndex((l) => {
        const r = rangeOf(l);
        return r && answer.number >= r[0] && answer.number <= r[1];
      });
      if (byRange !== -1) return byRange;
    }
    for (const want of answer.prefer) {
      const idx = labels.findIndex((l) => l.includes(want.toLowerCase()));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  if (answer.bool !== undefined) {
    const want = answer.bool ? /^(yes|y|true|sure|i am|i do|i can|i have)\b/ : /^(no|n|false|not)\b/;
    return labels.findIndex((l) => want.test(l));
  }

  if (answer.days !== undefined) {
    return labels.findIndex((l) => {
      const r = optionDays(l);
      return r && answer.days >= r[0] && answer.days <= r[1];
    });
  }

  if (answer.number !== undefined) {
    const exact = labels.findIndex((l) => {
      const r = rangeOf(l);
      return r && r[0] === r[1] && r[0] === Math.floor(answer.number);
    });
    if (exact !== -1) return exact;
    return labels.findIndex((l) => {
      const r = rangeOf(l);
      return r && answer.number >= r[0] && answer.number <= r[1];
    });
  }

  const want = answer.text.toLowerCase();
  const idx = labels.findIndex((l) => l === want || l.includes(want) || want.includes(l));
  if (idx !== -1) return idx;
  // "B.E. Computer Science" should match "B.E/B.Tech" or "Graduate".
  if (answer.rule === 'qualification') {
    return labels.findIndex((l) => /b\.? ?e\b|b\.? ?tech|bachelor|graduat|engineering/.test(l));
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Driving Naukri's chat-style questionnaire drawer.
// ---------------------------------------------------------------------------

const Q = {
  drawer: ['.chatbot_DrawerContentWrapper', '[class*="chatbot_Drawer"]'],
  // Each bot message; the last one is the current question.
  botMessage: ['.botMsg', '[class*="botMsg"]', '.chatbot_ListItem .botItem', 'li.botItem'],
  textBox: ['[contenteditable="true"]', 'textarea', 'input[type="text"]', 'input[type="number"]'],
  radio: ['input[type="radio"]'],
  checkbox: ['input[type="checkbox"]'],
  chip: ['.chatbot_Chip', '[class*="chipItem"]', '[class*="chatbot_Chip"]', '.chip'],
  save: ['.sendMsg', '[class*="sendMsg"]', 'button:text-is("Save")', 'div:text-is("Save")', 'button:text-is("Submit")'],
};

async function firstVisibleIn(root, candidates) {
  for (const selector of candidates) {
    const all = root.locator(selector);
    const n = await all.count().catch(() => 0);
    for (let i = n - 1; i >= 0; i -= 1) {
      const el = all.nth(i);
      if (await el.isVisible().catch(() => false)) return el;
    }
  }
  return null;
}

async function drawerRoot(page) {
  for (const selector of Q.drawer) {
    const el = page.locator(selector).first();
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

async function lastQuestion(drawer) {
  for (const selector of Q.botMessage) {
    const texts = await drawer.locator(selector).allInnerTexts().catch(() => []);
    const cleaned = texts.map((t) => t.trim()).filter(Boolean);
    if (cleaned.length) return cleaned[cleaned.length - 1];
  }
  return null;
}

/** Visible radio/checkbox options inside the drawer, with their label text. */
async function choiceOptions(drawer, kind) {
  const inputs = drawer.locator(`input[type="${kind}"]`);
  const n = await inputs.count();
  const options = [];
  for (let i = 0; i < n; i += 1) {
    const input = inputs.nth(i);
    const label = await input.evaluate((el) => {
      const byFor = el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      return (byFor?.innerText || el.closest('label')?.innerText || el.parentElement?.innerText || el.value || '').trim();
    });
    // The input itself is often visually hidden behind its label.
    const target = (await input.evaluate((el) => Boolean(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))))
      ? drawer.locator(`label[for="${await input.getAttribute('id')}"]`)
      : input;
    options.push({ label, target });
  }
  return options;
}

async function clickSave(page, drawer) {
  const save = await firstVisibleIn(drawer, Q.save);
  if (save) await save.click();
  else await page.keyboard.press('Enter');
}

/**
 * Answers the questionnaire one question at a time. Returns
 *   { status: 'done', answered }            drawer closed after answering
 *   { status: 'unanswered', question }      a question we cannot answer
 *   { status: 'stuck', question }           a control we do not recognise
 * In the last two cases nothing has been submitted: Naukri only sends the
 * application once the final question is answered, and we stop before that.
 */
export async function answerQuestionnaire(page, { candidate, resume, artifactDir, label, log }) {
  const answered = [];
  let previous = null;

  for (let step = 0; step < 15; step += 1) {
    // Wait for the next question (or for the drawer to close, i.e. finished).
    let drawer = null;
    let question = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      drawer = await drawerRoot(page);
      if (!drawer) return { status: 'done', answered };
      question = await lastQuestion(drawer);
      if (question && question !== previous) break;
      await page.waitForTimeout(500);
    }
    if (!question || question === previous) {
      // No new question appeared but the drawer stayed open.
      if (!(await drawerRoot(page))) return { status: 'done', answered };
      await capture(page, `questions-${label}-stalled`, artifactDir);
      return { status: 'stuck', question: question ?? '(no question text found)' };
    }
    // Let any options animate in.
    await page.waitForTimeout(800);

    // Thank-you / closing messages are not questions.
    if (!/[?:]\s*$|please (enter|select|share|mention|provide)|\b(how|what|which|when|where|are|do|have|is|will|can)\b/i.test(question)) {
      previous = question;
      continue;
    }

    const answer = decideAnswer(question, { candidate, resume });
    if (!answer) return { status: 'unanswered', question };

    const radios = await choiceOptions(drawer, 'radio');
    const checks = radios.length ? [] : await choiceOptions(drawer, 'checkbox');
    const chips = radios.length || checks.length ? [] : await drawer.locator(Q.chip.join(',')).all();

    if (radios.length || checks.length) {
      const options = radios.length ? radios : checks;
      const idx = chooseOption(answer, options.map((o) => o.label));
      if (idx === -1) return { status: 'unanswered', question: `${question} [options: ${options.map((o) => o.label).join(' | ')}]` };
      await options[idx].target.click();
      await clickSave(page, drawer);
      log(question, answer, options[idx].label);
    } else if (chips.length) {
      const labels = await Promise.all(chips.map((c) => c.innerText().then((t) => t.trim())));
      const idx = chooseOption(answer, labels);
      if (idx === -1) return { status: 'unanswered', question: `${question} [options: ${labels.join(' | ')}]` };
      await chips[idx].click();
      log(question, answer, labels[idx]);
    } else {
      const box = await firstVisibleIn(drawer, Q.textBox);
      if (!box) {
        await capture(page, `questions-${label}-unknown-control`, artifactDir);
        return { status: 'stuck', question };
      }
      await box.click();
      await box.fill(answer.text);
      await clickSave(page, drawer);
      log(question, answer, answer.text);
    }

    answered.push({ question, rule: answer.rule });
    previous = question;
  }

  await capture(page, `questions-${label}-too-many`, artifactDir);
  return { status: 'stuck', question: 'more than 15 questions' };
}
