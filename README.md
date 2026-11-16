# Naukri Resume Auto-Refresh & Auto-Apply

Two scheduled jobs on Naukri:

- **Resume refresh** re-uploads my resume once a day at 09:00 IST under an
  incrementing version name (`...-V6.pdf`, `...-V7.pdf`, …) so the profile keeps showing as
  recently updated.
- **Auto-apply** checks for jobs posted in the last day every 2 hours and
  applies to the ones whose skills match the resume. See
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
- **Schedule drift.** GitHub delays scheduled jobs on shared runners by
  10–60 minutes, and drops them entirely under heavy load. Treat "09:00 IST"
  and "every 2 hours" as approximate.
- **Schedule silently disabled.** GitHub disables cron on repos with 60 days
  of no activity. The daily version-bump commit from the refresh job counts
  as activity, so this self-heals while runs are succeeding — but a long failing
  streak can let it lapse.

## Auto-apply

`src/apply.js`, run by `.github/workflows/naukri-apply.yml` every 2 hours on
the hour (UTC). The refresh job runs at 03:30 UTC, between two apply runs, so
the two never use the session at the same time.

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

   The run stops at `MAX_APPLICATIONS` or when Naukri reports its daily quota.

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

Anything else, such as notice-period buyout or negotiability, "why do you
want to join us", or a skill you don't have, is **left unanswered and the job
is not submitted**. The log lists those questions at the end of each run, so
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
| `MAX_APPLICATIONS` | `4` | Per run. 12 runs/day × 4 = 48 stays under Naukri's ~50/day cap |
| `MIN_MATCHED_SKILLS` | `3` | Job tags that must appear in the resume |
| `MIN_MATCH_RATIO` | `0.4` | Share of a job's tags found in the resume |
| `YEARS_EXPERIENCE` | from resume | Overrides the parsed value |

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
