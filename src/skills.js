import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Tags so broad that nearly every tech job carries them. Counting them would
 * inflate the match score of jobs that share nothing real with the resume, so
 * they are dropped from both sides of the ratio.
 */
const GENERIC_TAGS = new Set([
  'it skills',
  'software development',
  'development',
  'software engineering',
  'engineering',
  'design',
  'management',
  'testing',
  'coding',
  'programming',
  'computer science',
  'technology',
  'communication skills',
  'communication',
  'problem solving',
  'teamwork',
  'web development',
  'application development',
  // Role and seniority words: they appear in any resume's prose, so a
  // full-text hit on them says nothing about skills.
  'senior',
  'junior',
  'lead',
  'developer',
  'engineer',
  'stack',
  'api',
  'apis',
]);

/** Different spellings of the same skill, collapsed to one canonical form. */
const ALIASES = new Map([
  ['amazon web services', 'aws'],
  ['generative ai', 'genai'],
  ['gen ai', 'genai'],
  ['large language models', 'llm'],
  ['large language model', 'llm'],
  ['llms', 'llm'],
  ['llm integration', 'llm'],
  ['rag pipelines', 'rag'],
  ['retrieval augmented generation', 'rag'],
  ['rest apis', 'rest api'],
  ['restful api', 'rest api'],
  ['restful apis', 'rest api'],
  ['rest', 'rest api'],
  ['postgres', 'postgresql'],
  ['mongo', 'mongodb'],
  ['mern stack', 'mern'],
  ['ci cd', 'cicd'],
  ['model context protocol', 'mcp'],
  ['vectors', 'vector database'],
  ['vector db', 'vector database'],
  ['ts', 'typescript'],
  ['js', 'javascript'],
]);

/**
 * Lowercases, strips the "js" suffix (React.js / ReactJS / React JS → react),
 * and drops punctuation, so tags and resume text compare like for like.
 */
export function normalize(raw) {
  let s = String(raw).toLowerCase().trim();
  if (s === 'js') return 'javascript';
  s = s.replace(/\.?\s?js\b/g, '');
  s = s.replace(/[^a-z0-9+#]+/g, ' ').trim();
  return ALIASES.get(s) ?? s;
}

async function pdfText(pdfPath) {
  const data = new Uint8Array(await readFile(pdfPath));
  const task = getDocument({ data, verbosity: 0 });
  const doc = await task.promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i += 1) {
    const content = await (await doc.getPage(i)).getTextContent();
    text += content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('');
    text += '\n';
  }
  await task.destroy();
  return text;
}

/**
 * Reads the resume and returns what the matcher needs: the explicit skill list
 * from the "Technical Skills" section, the whole text (so a tag like "Redux"
 * that only appears under Experience still counts), and the years of
 * experience claimed in the summary.
 */
export async function loadResumeProfile(pdfPath) {
  const text = await pdfText(pdfPath);

  const skills = new Set();
  const section = text.match(/technical skills\s*([\s\S]*?)(?:\n\s*(?:professional )?experience\b|$)/i);
  if (section) {
    for (const line of section[1].split('\n')) {
      // "Languages & Frameworks:   JavaScript, TypeScript, ..." → items after the colon.
      const items = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
      for (const item of items.split(/[,|•]/)) {
        const n = normalize(item);
        if (n && n.length <= 40) skills.add(n);
      }
    }
  }

  const years = text.match(/(\d{1,2})\s*\+?\s*years?\s+of\s+(?:professional\s+)?experience/i);

  return {
    skills,
    text,
    skillYears: skillYearsFromRoles(text, skills),
    // Padded with spaces so phrase lookups can require word boundaries.
    normalizedText: ` ${normalize(text.replace(/\s+/g, ' '))} `,
    years: years ? Number(years[1]) : null,
  };
}

/**
 * Scores a job's skill tags against the resume. Returns which tags matched and
 * the ratio of matched to meaningful (non-generic) tags.
 */
export function scoreJob(tags, profile) {
  const considered = [];
  const matched = [];
  const seen = new Set();
  for (const tag of tags) {
    const n = normalize(tag);
    // "Node" and "Node.js" normalize alike; count each skill once.
    if (!n || GENERIC_TAGS.has(n) || seen.has(n)) continue;
    seen.add(n);
    considered.push(tag);
    const singular = n.endsWith('s') ? n.slice(0, -1) : `${n}s`;
    if (
      profile.skills.has(n) ||
      profile.skills.has(singular) ||
      profile.normalizedText.includes(` ${n} `)
    ) {
      matched.push(tag);
    }
  }
  return {
    matched,
    considered: considered.length,
    ratio: considered.length ? matched.length / considered.length : 0,
  };
}

/** Parses "5-10 Yrs" into { min: 5, max: 10 }; null when it cannot. */
export function parseExperience(label) {
  const m = String(label ?? '').match(/(\d+)\s*-\s*(\d+)/);
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const DATE_RANGE = new RegExp(
  `\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{4})\\s*[–—-]\\s*(present|current|(${MONTHS})[a-z]*\\.?\\s+(\\d{4}))`,
  'i',
);

// A stack name in a role implies the skills it is made of.
const IMPLIES = new Map([
  ['mern', ['mongodb', 'react', 'node', 'javascript']],
  ['react', ['javascript']],
  ['angular', ['javascript']],
  ['typescript', ['javascript']],
]);

const monthIndex = (m) => MONTHS.split('|').indexOf(m.slice(0, 3).toLowerCase());

/**
 * Years of experience per skill, from the date ranges of the roles that
 * mention it. "6 years of React" when React only appears in a 2-year role
 * would be a false screening answer, so each skill is credited only with the
 * roles it actually appears in. Skills in no role are left out, and a
 * question about one is treated as unanswerable unless candidate.json gives
 * a figure in `skillYears`.
 */
export function skillYearsFromRoles(text, skills, now = new Date()) {
  const body = text.split(/\n\s*education\b/i)[0];
  const lines = body.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (DATE_RANGE.test(line)) starts.push(i);
  });

  const months = new Map();
  starts.forEach((lineIdx, k) => {
    const m = lines[lineIdx].match(DATE_RANGE);
    const from = new Date(Number(m[2]), monthIndex(m[1]));
    const to = /present|current/i.test(m[3]) ? now : new Date(Number(m[5]), monthIndex(m[4]));
    const span = Math.max(
      1,
      (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) + 1,
    );

    // A role runs from its title line (just above the dates) to the next one.
    const end = k + 1 < starts.length ? starts[k + 1] - 1 : lines.length;
    const roleText = ` ${normalize(lines.slice(Math.max(0, lineIdx - 1), end).join(' '))} `;

    const mentioned = new Set();
    for (const skill of [...skills, ...IMPLIES.keys()]) {
      if (roleText.includes(` ${skill} `)) mentioned.add(skill);
    }
    for (const [stack, parts] of IMPLIES) {
      if (mentioned.has(stack)) parts.forEach((p) => mentioned.add(p));
    }
    mentioned.delete('mern');
    for (const skill of mentioned) months.set(skill, (months.get(skill) ?? 0) + span);
  });

  const years = {};
  for (const [skill, total] of months) years[skill] = Math.round((total / 12) * 10) / 10;
  return years;
}
