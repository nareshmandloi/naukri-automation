const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Telegram rejects messages over 4096 characters.
const LIMIT = 4000;

export const telegramConfigured = () =>
  Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

const stripHtml = (html) =>
  html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

async function postMessage(text, html) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      ...(html ? { parse_mode: 'HTML' } : {}),
      disable_web_page_preview: true,
    }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: Boolean(json.ok), status: res.status, error: json.description ?? `HTTP ${res.status}` };
}

/**
 * Sends one HTML-formatted Telegram message (callers keep it under LIMIT —
 * see packLines). If Telegram rejects the formatting, the same content is
 * resent as plain text rather than lost. Throws if it still cannot be sent.
 */
export async function sendTelegram(html) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const r = await postMessage(html, true);
      if (r.ok) return;
      if (/parse entities|tag/i.test(r.error)) {
        const plain = await postMessage(stripHtml(html).slice(0, 4096), false);
        if (plain.ok) {
          console.log(`  (sent as plain text — Telegram rejected the formatting: ${r.error})`);
          return;
        }
        lastErr = new Error(`Telegram API: ${plain.error}`);
      } else {
        lastErr = new Error(`Telegram API: ${r.error}`);
      }
      if (r.status < 500) break;
    } catch (err) {
      lastErr = err; // network error: retry once
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw lastErr;
}

/**
 * Packs lines into as many messages as needed, each under Telegram's limit,
 * breaking only between lines so no HTML tag is ever cut in half.
 */
export function packLines(lines, limit = LIMIT) {
  const messages = [];
  let current = '';
  for (const raw of lines) {
    const line = raw.length > limit ? stripHtml(raw).slice(0, limit) : raw;
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit && current) {
      messages.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim()) messages.push(current);
  return messages;
}

export { esc };

/**
 * Sends a run summary to Telegram: every job applied to, jobs left for a
 * manual apply, and the running totals. Configured by TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID. Returns false, without throwing, when not configured.
 */
export async function sendRunReport({ applied, manual, counts, naukriTotal, runUrl, dryRun }) {
  if (!telegramConfigured()) {
    console.log('Telegram report not sent — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.');
    return false;
  }

  const n = applied.length;
  const lines = [
    `${dryRun ? '🧪 <b>[DRY RUN]</b> would apply to' : '✅ Applied to'} <b>${n} job${n === 1 ? '' : 's'}</b>`,
    `📊 Today <b>${counts.today}/${counts.dailyLimit}</b> · Bot total <b>${counts.total}</b>` +
      (naukriTotal != null ? ` · Naukri total <b>${naukriTotal}</b>` : ''),
    '',
    ...applied.map(
      (j, i) =>
        `${i + 1}. <a href="${esc(j.url)}">${esc(j.title)}</a> — ${esc(j.company)} (${j.matchPct}%)` +
        (j.note ? ` · <i>${esc(j.note)}</i>` : ''),
    ),
  ];

  if (manual.length) {
    lines.push('', `⚠️ <b>Apply manually (${manual.length})</b> — questions the bot can't answer truthfully:`);
    for (const j of manual) {
      lines.push(`• <a href="${esc(j.url)}">${esc(j.title)}</a> — ${esc(j.company)}: <i>${esc(j.note.slice(0, 120))}</i>`);
    }
  }
  lines.push('', `<i>Bot total counts since ${esc(counts.since)}.</i>` + (runUrl ? ` <a href="${esc(runUrl)}">Run log</a>` : ''));

  const messages = packLines(lines);
  for (const m of messages) await sendTelegram(m);
  console.log(`✓ Telegram report sent (${messages.length} message${messages.length === 1 ? '' : 's'})`);
  return true;
}
