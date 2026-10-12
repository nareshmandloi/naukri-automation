# Naukri Resume Auto-Refresh

Re-uploads my Naukri resume every 6 hours under an incrementing version name
(`...-V6.pdf`, `...-V7.pdf`, …) so the profile keeps showing as recently
updated.

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
  10–60 minutes, and drops them entirely under heavy load. Treat "every 6
  hours" as approximate.
- **Schedule silently disabled.** GitHub disables cron on repos with 60 days
  of no activity. The version-bump commit on each successful run counts as
  activity, so this self-heals while runs are succeeding — but a long failing
  streak can let it lapse.

## Updating the resume

Replace `resume/base.pdf` locally, then regenerate and re-paste the
`RESUME_BASE64` secret — the file itself is gitignored, so committing is neither
needed nor possible. Leave `state/version.json` alone so the version numbering
continues from where it was.
