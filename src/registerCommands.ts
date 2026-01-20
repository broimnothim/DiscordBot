import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import config from './config/config.json' with { type: 'json' };
import fs from 'fs-extra';
import path from 'path';

const TOKEN = process.env.DISCORD_TOKEN!;
const CLIENT_ID = process.env.CLIENT_ID!;
const cfgGuild = config.guildId;
const envGuild = process.env.GUILD_ID;
const isValidSnowflake = (v?: string) => !!v && /^\d{17,20}$/.test(v) && !/^0+$/.test(v);
const GUILD_ID = isValidSnowflake(cfgGuild) ? cfgGuild : isValidSnowflake(envGuild) ? envGuild : undefined;

async function main() {
  // Collect panel IDs from config and dynamic storage (data/panels/*.json)
  const cfgIds = (config.panels ?? []).map((p) => p.id);
  const dataDir = path.join(process.cwd(), 'data');
  const panelsDir = path.join(dataDir, 'panels');
  let dynIds: string[] = [];
  try {
    await fs.ensureDir(panelsDir);
    const files = await fs.readdir(panelsDir);
    for (const f of files) {
      if (f.endsWith('.json')) {
        const obj = await fs.readJSON(path.join(panelsDir, f)).catch(() => null);
        const id = obj?.id;
        if (typeof id === 'string') dynIds.push(id);
      }
    }
  } catch {}
  const panelChoices = Array.from(new Set([...cfgIds, ...dynIds])).slice(0, 25).map((id) => ({ name: id, value: id }));

  const commands = [
    new SlashCommandBuilder()
      .setName('setup-ticket')
      .setDescription('Crea/aggiorna il pannello ticket in un canale.')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Canale di testo destinazione').setRequired(true)
      )
      .addStringOption((opt) => {
        const o = opt
          .setName('panel_id')
          .setDescription('ID pannello (da /panel create)')
          .setRequired(false);
        for (const c of panelChoices) {
          o.addChoices(c);
        }
        return o;
      })
      .addStringOption((opt) =>
        opt
          .setName('panel')
          .setDescription('ID pannello scritto a mano (fallback se non compare tra le scelte)')
          .setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Gestione pannelli personalizzati.')
      .addSubcommand((sc) =>
        sc
          .setName('create')
          .setDescription('Crea un nuovo pannello')
          .addStringOption((o) =>
            o.setName('panel_id').setDescription('ID pannello (testo libero)').setRequired(true)
          )
          .addIntegerOption((o) =>
            o.setName('embed_color').setDescription('Colore embed (intero)').setRequired(false)
          )
          .addStringOption((o) =>
            o.setName('embed_footer').setDescription('Footer embed').setRequired(false)
          )
          .addStringOption((o) =>
            o.setName('embed_thumbnail').setDescription('URL thumbnail').setRequired(false)
          )
          .addStringOption((o) =>
            o.setName('embed_title').setDescription('Titolo embed').setRequired(false)
          )
          .addStringOption((o) =>
            o.setName('embed_description').setDescription('Descrizione embed').setRequired(false)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('add-button')
          .setDescription('Aggiunge un bottone al pannello')
          .addStringOption((o) =>
            o.setName('panel_id').setDescription('ID pannello').setRequired(true)
          )
          .addStringOption((o) =>
            o.setName('button_id').setDescription('ID bottone (testo libero)').setRequired(true)
          )
          .addStringOption((o) =>
            o.setName('button_label').setDescription('Testo bottone').setRequired(true)
          )
          .addStringOption((o) =>
            o
              .setName('button_style')
              .setDescription('Stile bottone')
              .addChoices(
                { name: 'Primary', value: 'Primary' },
                { name: 'Secondary', value: 'Secondary' },
                { name: 'Success', value: 'Success' },
                { name: 'Danger', value: 'Danger' }
              )
              .setRequired(true)
          )
          .addStringOption((o) =>
            o.setName('button_emoji').setDescription('Emoji (Unicode, es. 🔧)').setRequired(false)
          )
          .addStringOption((o) =>
            o
              .setName('target_id')
              .setDescription('ID categoria/canale (tasto destro → Copia ID)')
              .setRequired(false)
          )
          .addStringOption((o) =>
            o.setName('welcome_message').setDescription('Messaggio di benvenuto').setRequired(false)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName('remove-button')
          .setDescription('Rimuove un bottone')
          .addStringOption((o) => o.setName('panel_id').setDescription('ID pannello').setRequired(true))
          .addStringOption((o) => o.setName('button_id').setDescription('ID bottone').setRequired(true))
      )
      .addSubcommand((sc) =>
        sc
          .setName('add-field')
          .setDescription('Aggiunge un campo all\'embed')
          .addStringOption((o) => o.setName('panel_id').setDescription('ID pannello').setRequired(true))
          .addStringOption((o) => o.setName('name').setDescription('Nome campo').setRequired(true))
          .addStringOption((o) => o.setName('value').setDescription('Valore campo').setRequired(true))
          .addBooleanOption((o) => o.setName('inline').setDescription('Inline').setRequired(false))
      )
      .addSubcommand((sc) =>
        sc
          .setName('remove-field')
          .setDescription('Rimuove un campo dall\'embed')
          .addStringOption((o) => o.setName('panel_id').setDescription('ID pannello').setRequired(true))
          .addStringOption((o) => o.setName('name').setDescription('Nome campo').setRequired(true))
      )
      .addSubcommand((sc) =>
        sc
          .setName('help')
          .setDescription('Mostra guida rapida su come ottenere ID e configurare i pannelli')
      )
      .addSubcommand((sc) =>
        sc
          .setName('preview')
          .setDescription('Mostra un pannello in anteprima')
          .addStringOption((o) => o.setName('panel_id').setDescription('ID pannello').setRequired(true))
          .addChannelOption((o) => o.setName('channel').setDescription('Canale di destinazione').setRequired(true))
      )
      .addSubcommand((sc) =>
        sc
          .setName('publish')
          .setDescription('Pubblica un pannello')
          .addStringOption((o) => o.setName('panel_id').setDescription('ID pannello').setRequired(true))
          .addChannelOption((o) => o.setName('channel').setDescription('Canale di destinazione').setRequired(true))
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('close')
      .setDescription('Chiude e archivia il ticket corrente.')
      .addStringOption((opt) =>
        opt.setName('reason').setDescription('Motivo della chiusura').setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('adduser')
      .setDescription('Aggiunge un utente al ticket corrente.')
      .addUserOption((opt) => opt.setName('user').setDescription('Utente da aggiungere').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('removeuser')
      .setDescription('Rimuove un utente dal ticket corrente.')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Utente da rimuovere').setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('autorole-set')
      .setDescription('Imposta il ruolo da assegnare automaticamente ai nuovi membri.')
      .addRoleOption((opt) => opt.setName('role').setDescription('Il ruolo da assegnare').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('welcome-set')
      .setDescription('Imposta il canale per i messaggi di benvenuto.')
      .addChannelOption((opt) => opt.setName('channel').setDescription('Canale per i messaggi di benvenuto').setRequired(true))
      .toJSON()
  ];

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
