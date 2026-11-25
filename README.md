# Naukri Resume Auto-Refresh & Auto-Apply

Two scheduled jobs on Naukri:

- **Resume refresh** re-uploads my resume once a day around 09:00 IST under
  an incrementing version name (`...-V6.pdf`, `...-V7.pdf`, …) so the profile keeps showing as
  recently updated.
- **Auto-apply** checks hourly from 9:35 AM to 11:35 PM IST for jobs posted
  in the last day and applies,
  up to 50 a day, to the ones whose skills match the resume. See
  [Auto-apply](#auto-apply).

## How it works

1. `resume/base.pdf` is the pristine resume and is **never modified**.
2. Each run copies it and injects a unique PDF comment before the `%%EOF`
   trailer. Naukri skips a re-upload it considers byte-identical, so the bytes
   must differ — but because the comment lands after the xref table and after
   the `startxref` offset pointing at it, no offset shifts. The file stays
   spec-valid and ATS text extraction is unaffected. The file also does not
   grow run over run, since the copy always starts from the pristine base.
3. The copy is named from the counter in `state/version.json`, Playwright logs
   in and uploads it, and the profile is re-read to confirm the new filename
   is actually showing.
4. Only a **confirmed** upload advances the counter, which is then committed
   back to the repo. A failed run retries the same version number rather than
   burning one.

## Setup

This repo is **public**, so nothing personal is committed to it: the resume is
gitignored and lives in a secret instead, and credentials never leave your
machine.

### 1. Capture a login session

Naukri uses risk-based authentication. From this Mac — a familiar IP and a
device with login history — the password alone is accepted. From a GitHub
runner's datacenter IP it is not: Naukri treats it as suspicious and demands an
emailed OTP, which a scheduled job cannot answer.

Naukri only challenges during **login**, so the job avoids logging in at all.
Capture a session here, where no OTP is required, and let the runner replay it:

```bash
npm run session
```

That writes `session.json` (gitignored) and `session.b64`, whose contents go in
the `NAUKRI_SESSION_B64` secret. With that set, the runner never touches the
login form and never triggers an OTP.

The short-lived `nauk_at` access token in the session expires about an hour
after capture, but the `nauk_rt` refresh token is good for a year and Naukri
renews the access token on page load. If the refresh ever stops being honoured,
the run fails with *"The saved session is no longer valid"* — rerun
`npm run session` and update the secret.

### 2. Add the secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
| --- | --- |
| `NAUKRI_SESSION_B64` | Contents of `session.b64` — **this is what makes cloud runs work** |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional, for the run report (see [Telegram report](#telegram-report-after-every-run-that-applies)) |
| `CANDIDATE_PROFILE` | Base64 of `candidate.json`, for auto-apply's screening questions (see [Screening questions](#screening-questions)) |
| `RESUME_BASE64` | Base64 of your resume PDF (see below) |
| `NAUKRI_EMAIL` | Naukri login email (only used if no session is set) |
| `NAUKRI_PASSWORD` | Naukri password (only used if no session is set) |

Secrets are not readable by forks and are not exposed in logs, so they are safe
on a public repo. To regenerate the resume value at any time:

```bash
base64 -i resume/base.pdf | tr -d '
' | pbcopy
```

Then paste into `RESUME_BASE64`. The workflow decodes it back to
`resume/base.pdf` at the start of every run and verifies it is really a PDF.

### 3. Enable the schedule

Scheduled workflows only run once the workflow file is on the repo's **default
branch**. Then trigger a manual test:

Actions → *Naukri Resume Refresh* → **Run workflow** → tick `dry_run` → Run.

A dry run logs in and locates the upload field without uploading — the cheapest
way to confirm the secrets work and that Naukri is not blocking the runner's IP.
If it passes, run again with `dry_run` unticked.

## Running locally

Keep your resume at `resume/base.pdf` (gitignored, so it stays on your machine).

```bash
cp .env.example .env     # then fill in your email and password
npm install
npx playwright install chromium
npm run refresh          # or: npm run refresh:headed  (watch the browser)
```

`HEADLESS=false` opens a visible browser, which is the fastest way to see what
Naukri is actually showing.

## When it breaks

Diagnostics are the first stop: a failed CI run attaches a
**failure-diagnostics** artifact containing a full-page screenshot and the raw
DOM from the moment it gave up. Locally the same files land in `artifacts/`.

> Because this repo is public, those artifacts are downloadable by anyone for
> the 7 days they are retained. The generated resume PDF is deliberately
> excluded from them, but a screenshot taken on the profile page will still
> show profile details. Delete the artifact from the run page if that matters
> for a given failure.

Known failure modes, most likely first:

- **"The saved session is no longer valid".** The session secret has gone
  stale. Rerun `npm run session` on this Mac and update `NAUKRI_SESSION_B64`.
  This is the expected maintenance task, not a bug.
- **An OTP prompt.** Means the run fell back to password login because no
  session secret was set. Set `NAUKRI_SESSION_B64`. Note the job deliberately
  does **not** retry an OTP failure — each attempt sends another email.
- **Changed selectors.** Naukri A/B-tests its markup. Every element is looked
  up through an ordered candidate list in `src/naukri.js` (`SELECTORS`); add
  the new selector to the front of the relevant list.
- **Schedule drift.** GitHub delays scheduled jobs on shared runners, by
  hours at busy times, and drops some entirely. That is why the refresh has
  four backup times (09:03–10:33 IST, first one wins) and auto-apply runs
  hourly against a daily cap instead of relying on a fixed number of runs.
- **Schedule silently disabled.** GitHub disables cron on repos with 60 days
  of no activity. The daily version-bump and counter commits count as
  activity, so this self-heals while runs are succeeding — but a long failing
  streak can let it lapse.

## Auto-apply

`src/apply.js`, run by `.github/workflows/naukri-apply.yml` hourly from
9:35 AM to 11:35 PM IST (`5 4-18 * * *` UTC). GitHub drops a share of scheduled runs, so the **daily cap**
(`DAILY_LIMIT`, 50 per IST day), not the number of runs, is what limits
applications. Each run applies to at most `MAX_APPLICATIONS` (10), and a
dropped run costs nothing. The count lives in `state/applies.json` (numbers
only, no job details, since the repo is public) and is committed after each
run that applied.

1. **Skills come from the resume itself.** `resume/base.pdf` is parsed, and
   every item in its *Technical Skills* section becomes a skill. Years of
   experience are read from the summary ("6+ years of experience"). Change the
   resume and the matching follows; there is no separate list to maintain.
2. **Search.** Each keyword in `SEARCH_KEYWORDS` is searched with
   `jobAge=1` (posted in the last day) and your experience. Results are read
   from the JSON the results page fetches, with card scraping as a fallback.
3. **Match.** Each job's skill tags are normalized (`React.js` = `ReactJS` =
   `React`, `Generative AI` = `GenAI`, …) and compared with the resume. Generic
   tags such as "IT Skills" or "Senior" are ignored. A job qualifies when at
   least `MIN_MATCHED_SKILLS` tags match **and** at least `MIN_MATCH_RATIO` of
   its tags match, and the posted experience range fits within a year either
   way. The best matches are applied to first.
4. **Apply.** Opens the job and clicks Apply only for Naukri's one-click
   apply. These are skipped:
   - **Already applied.** Naukri remembers this, so no state is kept in the
     repo.
   - **"Apply on company site".** External forms can't be filled reliably.
   - **Screening questions it can't answer truthfully.** See below.

   The run stops at `MAX_APPLICATIONS`, at the daily cap, or when Naukri
   reports its own daily quota. In that last case the rest of the day's runs
   are skipped too.

### Screening questions

Many jobs open a chat drawer with questions before applying. The tool answers
them from two sources and never makes up an answer:

- **`candidate.json`**: facts only you know. It is gitignored. In CI the same
  JSON goes in the `CANDIDATE_PROFILE` secret.

  ```json
  {
    "currentCtcLpa": 35,
    "expectedCtcLpa": 45,
    "noticePeriodDays": 30,
    "currentCity": "Pune",
    "willingToRelocate": true,
    "relocationPreference": "Anywhere in India",
    "workModes": ["remote", "hybrid", "onsite"],
    "highestQualification": "B.E. Computer Science",
    "skillYears": {},
    "skillYearsRange": [4, 6]
  }
  ```

  `skillYearsRange` keeps every skill answer within that range: lower figures
  are raised, higher ones capped, and a skill the resume lists but no role
  mentions gets the minimum. `skillYears` sets an exact figure per skill,
  which is still clamped to the range. Remove the range to answer strictly
  from the resume.

- **The resume**: total years from the summary. Per-skill years come from
  the date ranges of the roles that mention each skill, so a 2½-year LangGraph
  role never turns into "6 years of LangGraph". A skill listed under Technical
  Skills but in no role (Docker, AWS, …) has no figure. Add one to
  `skillYears` to answer questions about it.

| Question | Answer |
| --- | --- |
| Current / expected CTC | From the profile, in the unit asked for: LPA by default, rupees if it says INR, monthly if it says per month |
| Notice period, "immediate joiner?" | `noticePeriodDays`. For a dropdown it picks the matching option ("1 Month", "16–30 days") |
| Current location | `currentCity` |
| Relocate / work from city X / remote / hybrid / on-site | Yes, per `willingToRelocate` and `workModes` |
| Total / relevant years | Resume summary |
| Years in skill X, "experience with X?" | Per-skill years, kept within `skillYearsRange`. A skill not on the resume is **not** answered |
| Qualification / bachelor's degree | `highestQualification` |

#### Answer bank

For questions the rules can't work out (reason for change, buyout, bond,
shifts, travel, APIs built, backend stack, GenAI experience, current
company, team size, …), `candidate.json` holds an `answerBank`: answers you
wrote or approved, each with regex `match` patterns and, for multiple-choice
questions, `options` keywords to pick in priority order:

```json
{ "id": "backend-tech",
  "match": ["which backend", "backend technolog"],
  "answer": "Node.js, along with Python for AI/RAG services.",
  "options": ["node", "python"] }
```

Rules are tried first and the bank second. If a multiple-choice question has
no option matching the entry, such as a bare Yes/No on a bond, it is skipped.
After editing `candidate.json`, update the `CANDIDATE_PROFILE` secret.

Every question the bot still can't answer is counted in
`state/unanswered-questions.json` (question text and counts only), committed
after each run. The most frequent ones are the next answers to add.

Anything else, such as "why do you want to join us", last working day, or a
skill you don't have, is **left unanswered and the job is not submitted**. The log lists those questions at the end of each run, so
you can add a rule or a `skillYears` entry. Naukri only submits once the last
question is answered, so stopping partway sends nothing.

To set the secret:

```bash
base64 -i candidate.json | tr -d '\n' | pbcopy   # paste into CANDIDATE_PROFILE
```

In CI the log shows which rule answered each question (`current-ctc`,
`years:react`, …) but never the answer itself.

### Try it first

```bash
npm run apply:dry      # find and score jobs, open each one, never click Apply
npm run apply:headed   # same, with a visible browser
npm run apply          # apply for real
```

In Actions, a **manual** run of *Naukri Auto-Apply* defaults to `dry_run`.
**Scheduled** runs apply for real.

### Tuning

Set these under **Settings → Secrets and variables → Actions → Variables**
(or in `.env` locally). All are optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEARCH_KEYWORDS` | `Full Stack Developer, GenAI Engineer, Node.js Developer, React Developer` | Comma-separated searches |
| `JOB_LOCATIONS` | anywhere | e.g. `pune,bangalore` |
| `DAILY_LIMIT` | `50` | Applications per IST day, across all runs |
| `MAX_APPLICATIONS` | `10` | Per run |
| `MIN_MATCHED_SKILLS` | `3` | Job tags that must appear in the resume |
| `MIN_MATCH_RATIO` | `0.4` | Share of a job's tags found in the resume |
| `YEARS_EXPERIENCE` | from resume | Overrides the parsed value |

### Telegram report after every run that applies

Each run that applies to at least one job sends one Telegram message listing:

- every job applied to, with a link and match %
- jobs left for a manual apply, with the question that stopped the bot
- the running totals: **today / 50**, the **bot's total** since the counter
  started (18 Nov 2026), and **Naukri's own "Total applies"**, which also
  includes applications made by hand and before the counter existed.

One-time setup, about 2 minutes:

1. In Telegram, message **@BotFather** → `/newbot` → pick a name. It replies
   with a **token**.
2. Open your new bot and press **Start**, or send it "hi".
3. Put `TELEGRAM_BOT_TOKEN=<token>` in `.env` and run `npm run telegram:setup`.
   It prints your `TELEGRAM_CHAT_ID` and sends a test message.
4. Add both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as repository secrets.

Besides the per-run report, Telegram also gets:

- **A daily check-in** after the morning resume upload, with the new version
  and the applications today and in total. If it stops arriving, something
  needs attention.
- **A ❌ alert** whenever either workflow fails, with a link to the log.

A **manual dry run** sends the same message marked `[DRY RUN]`, the easiest
way to confirm the secrets. If the secrets are **missing**, auto-apply still
applies but then **fails the run** with "Telegram reports are OFF". GitHub's
failure email then tells you, instead of the reports silently never arriving. Only you see the messages: a bot can only message chats that started
it.

### Privacy in logs

Actions logs on a public repo are public. In CI the job therefore logs each
job by index, match score and outcome, **not** by title or company. Set the
variable `LOG_JOB_DETAILS=true` to log details anyway. Local runs always show
them. Your full history is under *Naukri → Applies*.

## Updating the resume

Replace `resume/base.pdf` locally, then regenerate and re-paste the
`RESUME_BASE64` secret — the file itself is gitignored, so committing is neither
needed nor possible. Leave `state/version.json` alone so the version numbering
continues from where it was.
