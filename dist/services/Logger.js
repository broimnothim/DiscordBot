import fs from 'fs-extra';
import path from 'path';
export async function logEvent(dataDir, type, message) {
    const line = `[${new Date().toISOString()}] [${type}] ${message}\n`;
    const file = path.join(dataDir, 'events.log');
    await fs.ensureFile(file);
    await fs.appendFile(file, line, 'utf8');
}
export async function appendTicketMessage(dataDir, channelId, payload) {
    const dir = path.join(dataDir, 'tickets', channelId);
    const file = path.join(dir, 'messages.jsonl');
    await fs.ensureFile(file);
    await fs.appendFile(file, JSON.stringify(payload) + '\n', 'utf8');
}
export async function writeTranscriptHtml(dataDir, channelId, messages) {
    const dir = path.join(dataDir, 'tickets', channelId);
    await fs.ensureDir(dir);
    const html = `<!doctype html>
<html lang="it">
  <meta charset="utf-8" />
  <title>Transcript ${channelId}</title>
  <style>
    body{font-family: system-ui, sans-serif; background: #111; color: #eee; padding:20px;}
    .msg{margin:6px 0;padding:8px;border-radius:6px;background:#1b1b1b;}
    .meta{color:#aaa;font-size:12px;margin-bottom:4px;}
    .content{white-space:pre-wrap;}
  </style>
  <body>
    <h1>Transcript canale ${channelId}</h1>
    ${messages
        .map((m) => `<div class="msg"><div class="meta">${m.authorTag} (${m.authorId}) • ${m.createdAt}</div><div class="content">${escapeHtml(m.content)}</div></div>`)
        .join('\n')}
  </body>
</html>`;
    await fs.writeFile(path.join(dir, 'transcript.html'), html, 'utf8');
}
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
