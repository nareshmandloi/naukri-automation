const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Telegram rejects messages over 4096 characters.
const LIMIT = 4000;

/**
 * Sends a run summary to Telegram: every job applied to, jobs left for a
 * manual apply, and the running totals. Configured by TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID. Returns false, without throwing, when not configured.
 */
export async function sendRunReport({ applied, manual, counts, naukriTotal, runUrl, dryRun }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
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

  let text = lines.join('\n');
  if (text.length > LIMIT) text = `${text.slice(0, LIMIT)}\n…`;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram API: ${body.description ?? `HTTP ${res.status}`}`);
  console.log('✓ Telegram report sent');
  return true;
}
