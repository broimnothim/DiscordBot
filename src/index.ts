import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Collection,
  EmbedBuilder,
  GatewayIntentBits,
  GuildMember,
  Interaction,
  Message,
  PermissionFlagsBits,
  TextChannel,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';
import fs from 'fs-extra';
import http from 'http';
import path from 'path';
import { TicketService } from './services/TicketService.js';
import { logEvent } from './services/Logger.js';
import configData from './config/config.json' with { type: 'json' };
import { PanelService } from './services/PanelService.js';
import { StringSelectMenuBuilder } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  // Do not log secrets; just throw descriptive error
  throw new Error('DISCORD_TOKEN e CLIENT_ID non impostati. Usa un file .env per configurarli.');
}

// Ensure data directory
const DATA_DIR = path.join(process.cwd(), 'data');
await fs.ensureDir(DATA_DIR);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let autoroleId: string | null = configData.autoroleId;
let welcomeChannelId: string | null = configData.welcomeChannelId;
const ticketService = new TicketService(client, configData, DATA_DIR);
const panelService = new PanelService(DATA_DIR);
ticketService.setDynamicPanels(await panelService.list());

async function autoRegisterCommands() {
  const TOKEN = process.env.DISCORD_TOKEN!;
  const CLIENT_ID = process.env.CLIENT_ID!;
  const cfgGuild = configData.guildId;
  const envGuild = process.env.GUILD_ID;
  const isValidSnowflake = (v?: string) => !!v && /^\d{17,20}$/.test(v) && !/^0+$/.test(v);
  const GUILD_ID = isValidSnowflake(cfgGuild) ? cfgGuild : isValidSnowflake(envGuild) ? envGuild : undefined;

  // Collect panel IDs from config and dynamic storage
  const cfgIds = (configData.panels ?? []).map((p) => p.id);
  const panelsDir = path.join(DATA_DIR, 'panels');
  await fs.ensureDir(panelsDir);
  const files = await fs.readdir(panelsDir);
  const dynIds: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const obj = await fs.readJSON(path.join(panelsDir, f)).catch(() => null);
    const id = obj?.id;
    if (typeof id === 'string') dynIds.push(id);
  }
  const panelChoices = Array.from(new Set([...cfgIds, ...dynIds]))
    .slice(0, 25)
    .map((id) => ({ name: id, value: id }));

  const commands = [
    new SlashCommandBuilder()
      .setName('setup-ticket')
      .setDescription('Crea/aggiorna il pannello ticket in un canale.')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Canale di testo destinazione').setRequired(true)
      )
      .addStringOption((opt) => {
        const o = opt.setName('panel_id').setDescription('ID pannello (da /panel create)').setRequired(false);
        for (const c of panelChoices) o.addChoices(c);
        return o;
      })
      .addStringOption((opt) =>
        opt.setName('panel').setDescription('ID pannello scritto a mano').setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Gestione pannelli personalizzati.')
      .addSubcommand((sc) =>
        sc
          .setName('create')
          .setDescription('Crea un nuovo pannello')
          .addStringOption((o) => o.setName('panel_id').setDescription('ID pannello (testo libero)').setRequired(true))
          .addIntegerOption((o) => o.setName('embed_color').setDescription('Colore embed (intero)').setRequired(false))
          .addStringOption((o) => o.setName('embed_footer').setDescription('Footer embed').setRequired(false))
          .addStringOption((o) => o.setName('embed_thumbnail').setDescription('URL thumbnail').setRequired(false))
          .addStringOption((o) => o.setName('embed_title').setDescription('Titolo embed').setRequired(false))
          .addStringOption((o) => o.setName('embed_description').setDescription('Descrizione embed').setRequired(false))
      )
      .addSubcommand((sc) =>
        sc
          .setName('add-button')
          .setDescription('Aggiunge un bottone al pannello')
          .addStringOption((o) => o.setName('panel_id').setDescription('ID pannello').setRequired(true))
          .addStringOption((o) => o.setName('button_id').setDescription('ID bottone (testo libero)').setRequired(true))
          .addStringOption((o) => o.setName('button_label').setDescription('Testo bottone').setRequired(true))
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
          .addStringOption((o) => o.setName('button_emoji').setDescription('Emoji (Unicode, es. 🔧)').setRequired(false))
          .addStringOption((o) =>
            o.setName('target_id').setDescription('ID categoria/canale (tasto destro → Copia ID)').setRequired(false)
          )
          .addStringOption((o) => o.setName('welcome_message').setDescription('Messaggio di benvenuto').setRequired(false))
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
          .setDescription("Aggiunge un campo all'embed")
          .addStringOption((o) => o.setName('panel_id').setDescription('ID pannello').setRequired(true))
          .addStringOption((o) => o.setName('name').setDescription('Nome campo').setRequired(true))
          .addStringOption((o) => o.setName('value').setDescription('Valore campo').setRequired(true))
          .addBooleanOption((o) => o.setName('inline').setDescription('Inline').setRequired(false))
      )
      .addSubcommand((sc) =>
        sc
          .setName('remove-field')
          .setDescription("Rimuove un campo dall'embed")
          .addStringOption((o) => o.setName('panel_id').setDescription('ID pannello').setRequired(true))
          .addStringOption((o) => o.setName('name').setDescription('Nome campo').setRequired(true))
      )
      .addSubcommand((sc) => sc.setName('help').setDescription('Mostra guida rapida'))
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
    new SlashCommandBuilder().setName('close').setDescription('Chiude e archivia il ticket corrente.').addStringOption((opt) =>
      opt.setName('reason').setDescription('Motivo della chiusura').setRequired(false)
    ).toJSON(),
    new SlashCommandBuilder()
      .setName('adduser')
      .setDescription('Aggiunge un utente al ticket corrente.')
      .addUserOption((opt) => opt.setName('user').setDescription('Utente da aggiungere').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('removeuser')
      .setDescription('Rimuove un utente dal ticket corrente.')
      .addUserOption((opt) => opt.setName('user').setDescription('Utente da rimuovere').setRequired(true))
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
    await logEvent(DATA_DIR, 'commands', `Comandi registrati a livello di guild ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    await logEvent(DATA_DIR, 'commands', `Comandi registrati globalmente`);
  }
}

const PORT = Number(process.env.PORT ?? process.env.RENDER_PORT ?? 3000);
const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/' || url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ready: client.isReady(), ts: Date.now() }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false }));
});
server.listen(PORT, '0.0.0.0', async () => {
  await logEvent(DATA_DIR, 'http', `Health server on port ${PORT}`);
});

client.once('ready', async () => {
  await logEvent(DATA_DIR, 'ready', `Bot loggato come ${client.user?.tag}`);
  // Start inactivity monitor
  ticketService.startInactivityWatcher();
  client.user?.setPresence({
    activities: [{ name: 'Chaotic Smp', type: ActivityType.Playing }],
    status: 'online'
  });
  // Auto register commands on startup (useful su Render)
  await autoRegisterCommands().catch(async (e) => {
    await logEvent(DATA_DIR, 'commands-error', `Registrazione comandi fallita: ${String(e)}`);
  });
});

client.on('interactionCreate', async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      if (name === 'setup-ticket') {
        const isStaff = ticketService.memberHasAnyStaffRole(interaction.member as GuildMember);
        if (!isStaff) {
          const roleIds = ticketService.getMemberRoleIds(interaction.member as GuildMember);
          await logEvent(DATA_DIR, 'perm-deny', `setup-ticket negato a ${interaction.user.tag} roles=[${roleIds.join(',')}]`);
          return interaction.reply({
            ephemeral: true,
            content: `Non hai i permessi per usare questo comando.\nRuoli rilevati: ${roleIds.length ? roleIds.join(', ') : 'nessuno'}`
          });
        }
        const channel = interaction.options.getChannel('channel', true);
        const panelId =
          interaction.options.getString('panel_id') ??
          interaction.options.getString('panel') ??
          undefined;
        if (channel?.type !== ChannelType.GuildText) {
          return interaction.reply({ ephemeral: true, content: 'Seleziona un canale di testo per il pannello.' });
        }
        const recent = await (channel as TextChannel).messages.fetch({ limit: 20 }).catch(() => null);
        const hasPanel =
          !!recent &&
          Array.from(recent.values()).some((m) => {
            if (m.author.id !== client.user?.id) return false;
            const rows: any[] = (m.components as any) ?? [];
            return rows.some((row: any) =>
              ((row.components as any[]) ?? []).some(
                (c: any) => typeof c.customId === 'string' && c.customId.startsWith('ticket_open')
              )
            );
          });
        if (hasPanel) {
          return interaction.reply({ ephemeral: true, content: 'Esiste già un pannello in questo canale.' });
        }
        const embed = ticketService.buildPanelEmbed(panelId);
        const panel = ticketService.getPanel(panelId);
        let rows: ActionRowBuilder<ButtonBuilder>[] = [];
        if (panel?.buttons?.length) {
          const buttons = panel.buttons.map((b) => {
            const style =
              b.style === 'Secondary'
                ? ButtonStyle.Secondary
                : b.style === 'Success'
                ? ButtonStyle.Success
                : b.style === 'Danger'
                ? ButtonStyle.Danger
                : ButtonStyle.Primary;
            const btn = new ButtonBuilder()
              .setCustomId(`ticket_open:${b.id}`)
              .setLabel(b.label)
              .setStyle(style);
            if (b.emoji) btn.setEmoji(b.emoji);
            return btn;
          });
          for (let i = 0; i < buttons.length; i += 5) {
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)));
          }
        } else {
          const btn = new ButtonBuilder()
            .setCustomId('ticket_open')
            .setLabel(configData.defaultMessages.panelButtonLabel)
            .setStyle(ButtonStyle.Primary);
          rows = [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)];
        }
        const selectRows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
        const selects = panel?.selects ?? [];
        for (const s of selects) {
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`ticket_select:${s.id}`)
            .setPlaceholder(s.placeholder ?? 'Seleziona un\'opzione')
            .addOptions(
              ...s.options.map((o) => ({
                label: o.label,
                value: o.value,
                description: o.description,
                emoji: o.emoji as any
              }))
            );
          selectRows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
        }
        await (channel as TextChannel).send({ embeds: [embed], components: [...rows, ...selectRows] });
        await interaction.reply({ ephemeral: true, content: 'Pannello ticket creato.' });
        await logEvent(DATA_DIR, 'setup', `Pannello impostato in #${channel.name} da ${interaction.user.tag}`);
        return;
      }
      if (name === 'close') {
        if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
          return interaction.reply({ ephemeral: true, content: 'Questo comando va usato dentro un canale di ticket.' });
        }
        // permessi: opener o staff
        const entry = await ticketService.getTicketEntry(interaction.channel.id);
        const isStaff = ticketService.memberHasAnyStaffRole(interaction.member as GuildMember);
        const isOpener = entry?.openerId === interaction.user.id;
        if (!isStaff && !isOpener) {
          return interaction.reply({ ephemeral: true, content: 'Non hai i permessi per chiudere questo ticket.' });
        }
        const reason = interaction.options.getString('reason') ?? undefined;
        const closed = await ticketService.closeTicket(interaction.channel as TextChannel, interaction.user, reason);
        if (!closed) {
          return interaction.reply({ ephemeral: true, content: 'Questo canale non è un ticket aperto.' });
        }
        return interaction.reply({ ephemeral: true, content: 'Ticket chiuso e archiviato.' });
      }
      if (name === 'adduser') {
        if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
          return interaction.reply({ ephemeral: true, content: 'Usa questo comando nel canale del ticket.' });
        }
        if (!ticketService.memberHasAnyStaffRole(interaction.member as GuildMember)) {
          return interaction.reply({ ephemeral: true, content: 'Solo lo staff può aggiungere membri.' });
        }
        const user = interaction.options.getUser('user', true);
        const ok = await ticketService.addUserToTicket(interaction.channel as TextChannel, user);
        if (!ok) {
          return interaction.reply({ ephemeral: true, content: 'Canale non riconosciuto come ticket.' });
        }
        return interaction.reply({ ephemeral: true, content: `Aggiunto ${user.tag} al ticket.` });
      }
      if (name === 'removeuser') {
        if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
          return interaction.reply({ ephemeral: true, content: 'Usa questo comando nel canale del ticket.' });
        }
        if (!ticketService.memberHasAnyStaffRole(interaction.member as GuildMember)) {
          return interaction.reply({ ephemeral: true, content: 'Solo lo staff può rimuovere membri.' });
        }
        const user = interaction.options.getUser('user', true);
        const ok = await ticketService.removeUserFromTicket(interaction.channel as TextChannel, user);
        if (!ok) {
          return interaction.reply({ ephemeral: true, content: 'Canale non riconosciuto come ticket.' });
        }
        return interaction.reply({ ephemeral: true, content: `Rimosso ${user.tag} dal ticket.` });
      }
      if (name === 'autorole-set') {
        if (!ticketService.memberHasAnyStaffRole(interaction.member as GuildMember)) {
          return interaction.reply({ ephemeral: true, content: 'Solo lo staff può impostare l\'autorole.' });
        }
        const role = interaction.options.getRole('role', true);
        const configPath = path.join(process.cwd(), 'src', 'config', 'config.json');
        const configObj = await fs.readJSON(configPath);
        configObj.autoroleId = role.id;
        await fs.writeJSON(configPath, configObj, { spaces: 2 });
        autoroleId = role.id;
        return interaction.reply({ ephemeral: true, content: `Autorole impostato a ${role.name}.` });
      }
      if (name === 'welcome-set') {
        if (!ticketService.memberHasAnyStaffRole(interaction.member as GuildMember)) {
          return interaction.reply({ ephemeral: true, content: 'Solo lo staff può impostare il welcome.' });
        }
        const channel = interaction.options.getChannel('channel', true);
        if (channel?.type !== ChannelType.GuildText) {
          return interaction.reply({ ephemeral: true, content: 'Seleziona un canale di testo.' });
        }
        const configPath = path.join(process.cwd(), 'src', 'config', 'config.json');
        const configObj = await fs.readJSON(configPath);
        configObj.welcomeChannelId = channel.id;
        await fs.writeJSON(configPath, configObj, { spaces: 2 });
        welcomeChannelId = channel.id;
        return interaction.reply({ ephemeral: true, content: `Welcome impostato in ${channel.name}.` });
      }
      if (name === 'panel') {
        const sub = interaction.options.getSubcommand();
        if (!ticketService.memberHasAnyStaffRole(interaction.member as GuildMember)) {
          return interaction.reply({ ephemeral: true, content: 'Solo lo staff può gestire i pannelli.' });
        }
        if (sub === 'create') {
          const id = interaction.options.getString('panel_id', true);
          const color =
            interaction.options.getInteger('embed_color') ?? configData.embedTheme.color;
          const footer =
            interaction.options.getString('embed_footer') ?? configData.embedTheme.footerText;
          const thumbnail =
            interaction.options.getString('embed_thumbnail') ?? '';
          const title = interaction.options.getString('embed_title') ?? configData.defaultMessages.panelTitle;
          const description = interaction.options.getString('embed_description') ?? configData.defaultMessages.panelDescription;
          // Validation
          const errors: string[] = [];
          if (!id || id.trim().length === 0) errors.push('panel_id è obbligatorio.');
          if (title.length > 256) errors.push('Il titolo non può superare 256 caratteri.');
          if (description.length > 4096) errors.push('La descrizione non può superare 4096 caratteri.');
          if (color < 0 || color > 0xffffff) errors.push('embed_color deve essere un intero tra 0 e 16777215.');
          if (errors.length) {
            return interaction.reply({ ephemeral: true, content: `Errore creazione pannello:\n- ${errors.join('\n- ')}` });
          }
          const panel = {
            id,
            embedTheme: {
              color,
              footerText: footer,
              thumbnailUrl: thumbnail,
              title,
              description,
              fields: []
            },
            buttons: []
          };
          await panelService.save(panel);
          ticketService.setDynamicPanels(await panelService.list());
          // Read-back confirmation
          const saved = await panelService.get(id);
          if (!saved) {
            return interaction.reply({ ephemeral: true, content: `Si è verificato un errore nel salvataggio del pannello ${id}.` });
          }
          return interaction.reply({
            ephemeral: true,
            content: `Pannello ${id} creato e salvato.\nTitolo: ${saved.embedTheme?.title}\nDescrizione: ${saved.embedTheme?.description}\nColore: ${saved.embedTheme?.color}`
          });
        }
        if (sub === 'add-button') {
          const id = interaction.options.getString('panel_id', true);
          const panel = (await panelService.get(id)) ?? { id, buttons: [], embedTheme: { color: configData.embedTheme.color, footerText: configData.embedTheme.footerText, thumbnailUrl: '', fields: [] } };
          const button_id = interaction.options.getString('button_id', true);
          const label = interaction.options.getString('button_label', true);
          const style = interaction.options.getString('button_style', true);
          const emoji = interaction.options.getString('button_emoji') ?? undefined;
          const target = interaction.options.getString('target_id') ?? undefined;
          const welcome = interaction.options.getString('welcome_message') ?? undefined;
          panel.buttons = (panel.buttons ?? []).filter((b: any) => b.id !== button_id).concat([
            { id: button_id, label, style, emoji, targetId: target, welcomeMessage: welcome }
          ]);
          await panelService.save(panel as any);
          ticketService.setDynamicPanels(await panelService.list());
          return interaction.reply({ ephemeral: true, content: `Bottone ${button_id} aggiunto al pannello ${id}.` });
        }
        if (sub === 'remove-button') {
          const id = interaction.options.getString('panel_id', true);
          const button_id = interaction.options.getString('button_id', true);
          const panel = await panelService.get(id);
          if (!panel) return interaction.reply({ ephemeral: true, content: `Pannello ${id} non trovato.` });
          panel.buttons = (panel.buttons ?? []).filter((b) => b.id !== button_id);
          await panelService.save(panel);
          ticketService.setDynamicPanels(await panelService.list());
          return interaction.reply({ ephemeral: true, content: `Bottone ${button_id} rimosso da ${id}.` });
        }
        if (sub === 'add-field') {
          const id = interaction.options.getString('panel_id', true);
          const name = interaction.options.getString('name', true);
          const value = interaction.options.getString('value', true);
          const inline = interaction.options.getBoolean('inline') ?? false;
          const panel = (await panelService.get(id)) ?? { id, buttons: [], embedTheme: { color: configData.embedTheme.color, footerText: configData.embedTheme.footerText, thumbnailUrl: '', fields: [] } };
          panel.embedTheme = panel.embedTheme ?? { color: configData.embedTheme.color, footerText: configData.embedTheme.footerText, thumbnailUrl: '', fields: [] };
          panel.embedTheme.fields = (panel.embedTheme.fields ?? []).filter((f) => f.name !== name).concat([{ name, value, inline }]);
          await panelService.save(panel);
          ticketService.setDynamicPanels(await panelService.list());
          return interaction.reply({ ephemeral: true, content: `Campo aggiunto al pannello ${id}.` });
        }
        if (sub === 'remove-field') {
          const id = interaction.options.getString('panel_id', true);
          const name = interaction.options.getString('name', true);
          const panel = await panelService.get(id);
          if (!panel || !panel.embedTheme) return interaction.reply({ ephemeral: true, content: `Pannello ${id} non trovato.` });
          panel.embedTheme.fields = (panel.embedTheme.fields ?? []).filter((f) => f.name !== name);
          await panelService.save(panel);
          ticketService.setDynamicPanels(await panelService.list());
          return interaction.reply({ ephemeral: true, content: `Campo rimosso da ${id}.` });
        }
        if (sub === 'preview' || sub === 'publish') {
          const id = interaction.options.getString('panel_id', true);
          const channel = interaction.options.getChannel('channel', true);
          if (channel?.type !== ChannelType.GuildText) {
            return interaction.reply({ ephemeral: true, content: 'Seleziona un canale di testo.' });
          }
          const embed = ticketService.buildPanelEmbed(id);
          const panel = ticketService.getPanel(id);
          if (!panel) return interaction.reply({ ephemeral: true, content: `Pannello ${id} non trovato.` });
          let rows: ActionRowBuilder<ButtonBuilder>[] = [];
          if (panel?.buttons?.length) {
            const buttons = panel.buttons.map((b) => {
              const style =
                b.style === 'Secondary'
                  ? ButtonStyle.Secondary
                  : b.style === 'Success'
                  ? ButtonStyle.Success
                  : b.style === 'Danger'
                  ? ButtonStyle.Danger
                  : ButtonStyle.Primary;
              const btn = new ButtonBuilder()
                .setCustomId(`ticket_open:${b.id}`)
                .setLabel(b.label)
                .setStyle(style);
              if (b.emoji) btn.setEmoji(b.emoji);
              return btn;
            });
            for (let i = 0; i < buttons.length; i += 5) {
              rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)));
            }
          }
          const selectRows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
          const selects = panel?.selects ?? [];
          for (const s of selects) {
            const menu = new StringSelectMenuBuilder()
              .setCustomId(`ticket_select:${s.id}`)
              .setPlaceholder(s.placeholder ?? 'Seleziona un\'opzione')
              .addOptions(
                ...s.options.map((o) => ({
                  label: o.label,
                  value: o.value,
                  description: o.description,
                  emoji: o.emoji as any
                }))
              );
            selectRows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
          }
          await (channel as TextChannel).send({ embeds: [embed], components: [...rows, ...selectRows] });
          return interaction.reply({ ephemeral: true, content: sub === 'preview' ? 'Anteprima pubblicata.' : 'Pannello pubblicato.' });
        }
        if (sub === 'help') {
          const help = new EmbedBuilder()
            .setColor(configData.embedTheme.color)
            .setTitle('Guida Rapida Pannelli')
            .setDescription(
              [
                '• panel_id: testo a tua scelta per identificare il pannello.',
                '• target_id: ID di canale o categoria dove creare i ticket.',
                '  Come ottenerlo: Impostazioni → Avanzate → Modalità Sviluppatore → tasto destro sul canale/categoria → Copia ID.',
                '• button_emoji: emoji Unicode (es. 🔧).',
                '• embed_color: numero intero (es. 5814783).',
                '• embed_footer/thumbnail: testo e URL per l\'embed.',
                '• button_style: Primary, Secondary, Success, Danger.'
              ].join('\n')
            )
            .setFooter({ text: configData.embedTheme.footerText })
            .setTimestamp(new Date());
          return interaction.reply({ ephemeral: true, embeds: [help] });
        }
      }
    } else if (interaction.isButton()) {
      if (interaction.customId.startsWith('ticket_open')) {
        const ratelimited = ticketService.isUserRateLimited(interaction.user.id);
        if (ratelimited) {
          return interaction.reply({
            ephemeral: true,
            content: `Puoi aprire un nuovo ticket tra ${ratelimited.remaining} minuti.`
          });
        }
        const parts = interaction.customId.split(':');
        const presetId = parts[1];
        if (presetId === 'staffer') {
          const select = new StringSelectMenuBuilder()
            .setCustomId('ticket_select:staffer')
            .setPlaceholder('Scegli il tipo di candidatura staffer')
            .addOptions(
              {
                label: 'Discord',
                value: 'staffer-discord',
                description: 'Candidatura per staff Discord',
                emoji: '👥'
              },
              {
                label: 'Minecraft',
                value: 'staffer-minecraft',
                description: 'Candidatura per staff Minecraft',
                emoji: '👥'
              }
            );
          const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
          const embed = new EmbedBuilder()
            .setTitle('Seleziona Tipo Candidatura Staffer')
            .setDescription('Scegli l\'opzione appropriata per la tua candidatura.')
            .setColor(5814783);
          return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }
        const preset = presetId ? ticketService.getButtonPreset(presetId) : undefined;
        await ticketService.createTicket(interaction, preset);
      } else if (interaction.customId === 'ticket_close') {
        try {
          await interaction.deferReply({ ephemeral: true });
        } catch (err) {
          // Se deferReply fallisce, usa reply direttamente
          if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
            return interaction.reply({ ephemeral: true, content: 'Questo bottone va usato dentro un canale di ticket.' });
          }
          const entry = await ticketService.getTicketEntry(interaction.channel.id);
          if (!entry) {
            return interaction.reply({ ephemeral: true, content: 'Questo canale non è riconosciuto come ticket.' });
          }
          const isStaff = ticketService.memberHasAnyStaffRole(interaction.member as GuildMember);
          const isMember = entry.members.includes(interaction.user.id);
          if (!isStaff && !isMember) {
            return interaction.reply({ ephemeral: true, content: 'Non fai parte di questo ticket.' });
          }
          const ok = await ticketService.closeTicket(interaction.channel as TextChannel, interaction.user, 'Chiusura tramite bottone');
          if (!ok) {
            return interaction.reply({ ephemeral: true, content: 'Impossibile chiudere: il canale non è un ticket aperto.' });
          }
          return interaction.reply({ ephemeral: true, content: 'Ticket chiuso e archiviato.' });
        }
        if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
          return interaction.editReply({ content: 'Questo bottone va usato dentro un canale di ticket.' });
        }
        const entry = await ticketService.getTicketEntry(interaction.channel.id);
        if (!entry) {
          return interaction.editReply({ content: 'Questo canale non è riconosciuto come ticket.' });
        }
        const isStaff = ticketService.memberHasAnyStaffRole(interaction.member as GuildMember);
        const isMember = entry.members.includes(interaction.user.id);
        if (!isStaff && !isMember) {
          return interaction.editReply({ content: 'Non fai parte di questo ticket.' });
        }
        const ok = await ticketService.closeTicket(interaction.channel as TextChannel, interaction.user, 'Chiusura tramite bottone');
        if (!ok) {
          return interaction.editReply({ content: 'Impossibile chiudere: il canale non è un ticket aperto.' });
        }
        return interaction.editReply({ content: 'Ticket chiuso e archiviato.' });
      }
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('ticket_select:')) {
        const id = interaction.customId.split(':')[1];
        const value = interaction.values[0];
        let targetPreset: any = undefined;
        if (id === 'staffer') {
          const targetId = '1462566706873503919';
          const welcomeMessage = value === 'staffer-discord'
            ? "Età attuale.?\n\nCosa ti ha colpito del nostro progetto?\n\nQuanto tempo pensi di poter dedicare al server ogni settimana (in ore)? In quali fasce orarie sei solitamente online?\n\nHai già ricoperto ruoli di staff (moderatore, helper, admin, builder, ecc.) su altri server Minecraft o Discord? Se sì, specifica quali ruoli, su quali server e per quanto tempo.\n\nUn giocatore ti insulta ripetutamente in chat. Come procedi passo per passo?\n\nSpiega la differenza tra un mute temporaneo e un ban permanente. In quali casi useresti l’uno o l’altro?"
            : "Nome in gioco (Minecraft) e nickname Discord con cui ti presenti.\n\nEtà attuale.?\n\nCosa ti ha colpito del nostro progetto?\n\nQuanto tempo pensi di poter dedicare al server ogni settimana (in ore)? In quali fasce orarie sei solitamente online?\n\nHai già ricoperto ruoli di staff (moderatore, helper, admin, builder, ecc.) su altri server Minecraft o Discord? Se sì, specifica quali ruoli, su quali server e per quanto tempo.\n\nHai esperienza con plugin o strumenti specifici come: LuckPerms, LiteBans, AdvancedBan, CoreProtect, Dynmap, WorldEdit, Citizens, o altri?\n\nCome gestisci una situazione in cui un giocatore ti segnala che un altro sta griefando la sua base?\n\nUn giocatore ti insulta ripetutamente in chat. Come procedi passo per passo?\n\nSpiega la differenza tra un mute temporaneo e un ban permanente. In quali casi useresti l’uno o l’altro?\n\nSai usare i comandi di moderazione di base di Minecraft (es. /ban, /kick, /mute) e di Discord (timeout, ban, ruolo mute)?\n\nHai mai costruito mappe o creato eventi per server? Se sì, descrivi brevemente un esempio.";
          targetPreset = { id: `select:${id}:${value}`, label: value === 'staffer-discord' ? 'Candidatura Staffer Discord' : 'Candidatura Staffer Minecraft', style: 'Primary', targetId, welcomeMessage };
          await ticketService.createTicket(interaction, targetPreset);
        } else {
          const preset = ticketService.getSelectPreset(id);
          const option = preset?.options.find((o) => o.value === value);
          targetPreset = option?.targetId
            ? { id: `select:${id}:${value}`, label: option.label, style: 'Primary', targetId: option.targetId, welcomeMessage: option.welcomeMessage }
            : undefined;
          await ticketService.createTicket(interaction, targetPreset);
        }
      }
    }
  } catch (err) {
    await logEvent(DATA_DIR, 'error', String(err));
    try {
      if (interaction.isRepliable()) {
        await interaction.reply({ ephemeral: true, content: 'Si è verificato un errore.' });
      }
    } catch {}
  }
});

client.on('messageCreate', async (message: Message) => {
  if (!message.guild || message.author.bot) return;
  await ticketService.trackMessageIfTicket(message);
});

client.on('guildMemberAdd', async (member: GuildMember) => {
  if (autoroleId) {
    try {
      await member.roles.add(autoroleId);
    } catch (e) {
      await logEvent(DATA_DIR, 'autorole-error', `Errore assegnazione autorole a ${member.user.tag}: ${String(e)}`);
    }
  }
  if (welcomeChannelId) {
    try {
      const channel = member.guild.channels.cache.get(welcomeChannelId) as TextChannel;
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(configData.embedTheme.color)
          .setTitle('Benvenuto nel server!')
          .setDescription(`Benvenuto <@${member.id}>! Per favore leggi le info <#1458834198868529195> così che tu capisca bene.\n\nQuesta Chaotic SMP è nata da un gruppo di amici appassionati di Minecraft che volevano creare un ambiente comunitario dove tutti potessero costruire, esplorare e divertirsi insieme in un mondo creativo e caotico.\n\nSiamo ora **${member.guild.memberCount}** membri!`)
          .setImage('https://cdn.discordapp.com/attachments/1457514645198995599/1463235017831612426/chaoticccc.jpg?ex=6971174d&is=696fc5cd&hm=6d831c83f57a2069a173495a52759c192de481f9c9f571c07b79b4adcbe3a995&')
          .setFooter({ text: configData.embedTheme.footerText })
          .setTimestamp();
        await channel.send({ embeds: [embed] });
      }
    } catch (e) {
      await logEvent(DATA_DIR, 'welcome-error', `Errore invio embed welcome a ${member.user.tag}: ${String(e)}`);
    }
  }
});

await client.login(TOKEN);
