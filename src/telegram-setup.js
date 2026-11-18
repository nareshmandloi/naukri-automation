import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(path.join(ROOT, '.env'));

/**
 * One-time helper: finds the chat ID of whoever last messaged your bot and
 * sends a test message there. Put TELEGRAM_BOT_TOKEN in .env, send your bot
 * any message in Telegram, then run `npm run telegram:setup`.
 */
async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Put TELEGRAM_BOT_TOKEN=<token from @BotFather> in .env first.');

  const api = (method, body) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then((r) => r.json());

  const updates = await api('getUpdates');
  if (!updates.ok) throw new Error(`Telegram API: ${updates.description}`);

  const chats = new Map();
  for (const u of updates.result) {
    const chat = (u.message ?? u.edited_message ?? u.my_chat_member)?.chat;
    if (chat) chats.set(chat.id, chat.first_name ?? chat.title ?? chat.username ?? '');
  }
  if (!chats.size) {
    throw new Error('No messages found. Open your bot in Telegram, press Start / send "hi", then rerun.');
  }

  for (const [id, name] of chats) {
    const sent = await api('sendMessage', { chat_id: id, text: '✅ Naukri bot connected. Application reports will arrive here.' });
    console.log(`chat ${name}: TELEGRAM_CHAT_ID=${id}  ${sent.ok ? '(test message sent)' : `(send failed: ${sent.description})`}`);
  }
  console.log('\nAdd TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as repository secrets.');
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exitCode = 1;
});
