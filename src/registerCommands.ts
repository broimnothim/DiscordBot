import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import config from './config/config.json' with { type: 'json' };
import fs from 'fs-extra';
import path from 'path';
import { getCommands } from './commands/definitions.js';
import { resolveGuildId } from './utils/guildId.js';

const TOKEN = process.env.DISCORD_TOKEN!;
const CLIENT_ID = process.env.CLIENT_ID!;
const GUILD_ID = resolveGuildId(config.guildId, process.env.GUILD_ID);

async function main() {
  const cfgIds = (config.panels ?? []).map((p: { id: string }) => p.id);
  const dataDir = path.join(process.cwd(), 'data');
  const panelsDir = path.join(dataDir, 'panels');
  let dynIds: string[] = [];
  try {
    await fs.ensureDir(panelsDir);
    const files = await fs.readdir(panelsDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    const results = await Promise.all(
      jsonFiles.map((f) => fs.readJSON(path.join(panelsDir, f)).catch(() => null))
    );
    for (const obj of results) {
      const id = obj?.id;
      if (typeof id === 'string') dynIds.push(id);
    }
  } catch {}
  const panelChoices = Array.from(new Set([...cfgIds, ...dynIds]))
    .slice(0, 25)
    .map((id) => ({ name: id, value: id }));

  const commands = getCommands(panelChoices);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Comandi registrati a livello di guild.');
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Comandi registrati globalmente.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
