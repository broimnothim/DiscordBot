import fs from 'fs-extra';
import path from 'path';

export async function logEvent(dataDir: string, type: string, message: string) {
  const line = `[${new Date().toISOString()}] [${type}] ${message}\n`;
  const file = path.join(dataDir, 'events.log');
  await fs.ensureFile(file);
  await fs.appendFile(file, line, 'utf8');
}

export async function appendTicketMessage(
  dataDir: string,
  channelId: string,
  payload: Record<string, unknown>
) {
  const dir = path.join(dataDir, 'tickets', channelId);
  const file = path.join(dir, 'messages.jsonl');
  await fs.ensureFile(file);
  await fs.appendFile(file, JSON.stringify(payload) + '\n', 'utf8');
}

export type TranscriptCloseInfo = {
  statedClosedBy?: string;
  actualCloserId?: string;
  actualCloserTag?: string;
};

export async function writeTranscriptHtml(
  dataDir: string,
  channelId: string,
  messages: Array<{
    id: string;
    authorTag: string;
    authorId: string;
    content: string;
    createdAt: string;
  }>,
  closeInfo?: TranscriptCloseInfo
) {
  const dir = path.join(dataDir, 'tickets', channelId);
  await fs.ensureDir(dir);
  const closeSection =
    closeInfo && (closeInfo.statedClosedBy || closeInfo.actualCloserId)
      ? `
    <div class="msg" style="margin-top:16px; border-left: 3px solid #f66;">
      <div class="meta">Chiusura ticket</div>
      <div class="content">${escapeHtml(closeInfo.statedClosedBy ? `Chiuso da (dichiarato): ${closeInfo.statedClosedBy}` : '')}${closeInfo.statedClosedBy && closeInfo.actualCloserId ? '\n' : ''}${closeInfo.actualCloserId ? `Chiuso materialmente da: ${escapeHtml(closeInfo.actualCloserTag ?? '')} (ID: ${escapeHtml(closeInfo.actualCloserId)})` : ''}</div>
    </div>`
      : '';
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
      .map(
        (m) =>
          `<div class="msg"><div class="meta">${escapeHtml(m.authorTag)} (${m.authorId}) • ${m.createdAt}</div><div class="content">${escapeHtml(
            m.content
          )}</div></div>`
      )
      .join('\n')}
    ${closeSection}
  </body>
</html>`;
  await fs.writeFile(path.join(dir, 'transcript.html'), html, 'utf8');
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
