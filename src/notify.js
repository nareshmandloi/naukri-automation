const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Telegram rejects messages over 4096 characters.
const LIMIT = 4000;

export const telegramConfigured = () =>
  Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

/** Sends one HTML-formatted Telegram message. Throws on an API error. */
export async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const body = text.length > LIMIT ? `${text.slice(0, LIMIT)}\n…` : text;
  // Two attempts: a single dropped connection should not cost a report.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: body, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (json.ok) return;
      lastErr = new Error(`Telegram API: ${json.description ?? `HTTP ${res.status}`}`);
      if (res.status < 500) break;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw lastErr;
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
      lines.push(`• <a href="${esc(j.url)}">${esc(j.title)}</a> — ${esc(j.company)}: <i>${esc(j.note.slice(0, 150))}</i>`);
    }
  }
  lines.push('', `<i>Bot total counts since ${esc(counts.since)}.</i>` + (runUrl ? ` <a href="${esc(runUrl)}">Run log</a>` : ''));

  await sendTelegram(lines.join('\n'));
  console.log('✓ Telegram report sent');
  return true;
}
