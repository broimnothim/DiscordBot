import {
  ChannelType,
  Client,
  GuildMember,
  PermissionFlagsBits,
  TextChannel,
  EmbedBuilder,
  APIEmbedField,
  Interaction,
  User,
  OverwriteResolvable,
  AttachmentBuilder,
  ChannelType as DjsChannelType,
  PermissionsBitField
} from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import fs from 'fs-extra';
import path from 'path';
import { appendTicketMessage, logEvent, writeTranscriptHtml, TranscriptCloseInfo } from './Logger.js';

type Config = {
  guildId: string;
  ticketCategoryId: string;
  archiveCategoryId: string;
  staffRoleIds: string[];
  rateLimitMinutes: number;
  inactivityTimeoutHours: number;
  defaultMessages: {
    ticketWelcome: string;
    ticketClosed: string;
    panelTitle: string;
    panelDescription: string;
    panelButtonLabel: string;
    closeButtonLabel?: string;
  };
  embedTheme: {
    color: number;
    footerText: string;
    thumbnailUrl?: string;
    title?: string;
    description?: string;
    fields: APIEmbedField[];
  };
  panels?: PanelConfig[];
};

type TicketIndexEntry = {
  channelId: string;
  openerId: string;
  createdAt: string;
  lastActiveAt: string;
  members: string[];
  welcomeMessageId?: string;
};

export type ButtonPreset = {
  id: string;
  label: string;
  style: string;
  emoji?: string;
  targetId?: string;
  welcomeMessage?: string;
  archiveTargetId?: string;
};

export type SelectOptionPreset = {
  label: string;
  value: string;
  description?: string;
  emoji?: string;
  targetId?: string;
  welcomeMessage?: string;
};

export type SelectPreset = {
  id: string;
  placeholder?: string;
  options: SelectOptionPreset[];
};

export type PanelConfig = {
  id: string;
  embedTheme?: {
    color: number;
    footerText: string;
    thumbnailUrl?: string;
    title?: string;
    description?: string;
    fields: APIEmbedField[];
  };
  buttons: ButtonPreset[];
  selects?: SelectPreset[];
};

export class TicketService {
  private client: Client;
  private config: Config;
  private dataDir: string;
  private rateLimitByUser = new Map<string, number>();
  private inactivityTimer?: NodeJS.Timeout;
  private dynamicPanels: PanelConfig[] = [];
  // Lock per prevenire creazioni concorrenti dello stesso utente
  private creatingByUser = new Set<string>();
  // Lock per serializzare accessi all'indice (read-modify-write)
  private indexLock: Promise<void> = Promise.resolve();

  // File lock path
  private get lockFilePath() {
    return path.join(this.dataDir, 'ticket_creation.lock');
  }

  constructor(client: Client, config: Config, dataDir: string) {
    this.client = client;
    this.config = config;
    this.dataDir = dataDir;
  }

  memberHasAnyStaffRole(member: GuildMember | { roles?: string[]; permissions?: any } | null): boolean {
    if (!member) return false;
    const m: any = member as any;
    if (m.roles?.cache) {
      return m.roles.cache.some((r: any) => this.config.staffRoleIds.includes(r.id));
    }
    if (Array.isArray(m.roles)) {
      return (m.roles as string[]).some((id) => this.config.staffRoleIds.includes(id));
    }
    // Fallback: check admin/manage permissions if provided as string
    if (typeof m.permissions === 'string') {
      const bits = new PermissionsBitField(BigInt(m.permissions));
      if (bits.has(PermissionFlagsBits.Administrator) || bits.has(PermissionFlagsBits.ManageChannels)) {
        return true;
      }
    } else if (m.permissions?.has) {
      if (m.permissions.has(PermissionFlagsBits.Administrator) || m.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return true;
      }
    }
    return false;
  }

  buildPanelEmbed(panelId?: string) {
    const theme = this.getPanel(panelId)?.embedTheme ?? this.config.embedTheme;
    const embed = new EmbedBuilder()
      .setColor(theme.color)
      .setTitle(theme.title ?? this.config.defaultMessages.panelTitle)
      .setDescription(theme.description ?? this.config.defaultMessages.panelDescription)
      .addFields(theme.fields ?? [])
      .setTimestamp(new Date())
      .setFooter({ text: theme.footerText });
    if (theme.thumbnailUrl) {
      embed.setThumbnail(theme.thumbnailUrl);
    }
    return embed;
  }

  buildPanelComponents(panelId?: string): {
    embed: EmbedBuilder;
    buttonRows: ActionRowBuilder<ButtonBuilder>[];
    selectRows: ActionRowBuilder<StringSelectMenuBuilder>[];
  } {
    const embed = this.buildPanelEmbed(panelId);
    const panel = this.getPanel(panelId);
    const buttonRows: ActionRowBuilder<ButtonBuilder>[] = [];
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
        buttonRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)));
      }
    } else {
      const btn = new ButtonBuilder()
        .setCustomId('ticket_open')
        .setLabel(this.config.defaultMessages.panelButtonLabel)
        .setStyle(ButtonStyle.Primary);
      buttonRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(btn));
    }
    const selectRows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
    const selects = panel?.selects ?? [];
    for (const s of selects) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`ticket_select:${s.id}`)
        .setPlaceholder(s.placeholder ?? "Seleziona un'opzione")
        .addOptions(
          ...s.options.map((o) => ({
            label: o.label,
            value: o.value,
            description: o.description,
            emoji: o.emoji as string | undefined
          }))
        );
      selectRows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
    }
    return { embed, buttonRows, selectRows };
  }

  getPanel(id?: string): PanelConfig | undefined {
    if (!id) return undefined;
    const fromDynamic = this.dynamicPanels.find((p) => p.id === id);
    if (fromDynamic) return fromDynamic;
    return this.config.panels?.find((p) => p.id === id);
  }

  getButtonPreset(id: string): ButtonPreset | undefined {
    for (const p of [...this.dynamicPanels, ...(this.config.panels ?? [])]) {
      const b = p.buttons.find((x) => x.id === id);
      if (b) return b;
    }
    return undefined;
  }

  getSelectPreset(id: string): SelectPreset | undefined {
    for (const p of [...this.dynamicPanels, ...(this.config.panels ?? [])]) {
      const s = (p.selects ?? []).find((x) => x.id === id);
      if (s) return s;
    }
    return undefined;
  }

  setDynamicPanels(panels: PanelConfig[]) {
    this.dynamicPanels = panels;
  }

  setStaffRoleIds(ids: string[]) {
    this.config.staffRoleIds = ids;
  }

  async createTicket(interaction: Interaction, preset?: ButtonPreset) {
    if (!interaction.guild || !interaction.user) return null;
    const openerId = interaction.user.id;

    // Check rate limit
    const limit = this.isUserRateLimited(openerId);
    if (limit) {
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({
            ephemeral: true,
            content: `Puoi aprire un nuovo ticket tra ${limit.remaining} minuti.`
          });
        }
      } catch {}
      return null;
    }

    // Process Lock (In-Memory)
    if (this.creatingByUser.has(openerId)) {
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ ephemeral: true, content: 'Stai già creando un ticket. Aspetta un momento.' });
        }
      } catch {}
      return null;
    }
    this.creatingByUser.add(openerId);

    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.deferReply({ ephemeral: true });
      }
    } catch {}

    // Global File Lock (Cross-Process)
    let fileLockAcquired = false;
    let channel: TextChannel | undefined;
    try {
      fileLockAcquired = await this.acquireFileLock(openerId);
      if (!fileLockAcquired) {
        try {
          if (interaction.isRepliable() && !interaction.replied) {
            if (interaction.deferred) {
              await interaction.editReply({ content: 'Operazione in corso (lock attivo). Riprova tra poco.' });
            } else {
              await interaction.reply({ ephemeral: true, content: 'Operazione in corso (lock attivo). Riprova tra poco.' });
            }
          }
        } catch {}
        return null;
      }

      const guild = interaction.guild;
      const target = preset?.targetId ?? this.config.ticketCategoryId;

      // Double check index AFTER acquiring file lock
      const idx0 = await this.readIndex();
      const existingByOpener = idx0.find((e) => e.openerId === openerId);
      if (existingByOpener) {
        const ch = await guild.channels.fetch(existingByOpener.channelId).catch(() => null);
        if (ch && (ch as any).type === ChannelType.GuildText) {
          const msg = 'Hai già un ticket aperto: <#' + existingByOpener.channelId + '>';
          try {
            if (interaction.isRepliable() && !interaction.replied) {
              if (interaction.deferred) await interaction.editReply({ content: msg });
              else await interaction.reply({ ephemeral: true, content: msg });
            }
          } catch {}
          return null;
        }
      }

      const categoryId = await this.resolveParentCategoryId(target, guild);

      const overwrites: OverwriteResolvable[] = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: openerId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      },
      ...this.config.staffRoleIds.map((id) => ({
        id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages
        ]
      }))
    ];

    const typeSlug = (() => {
      const src = (preset?.id ?? preset?.label ?? 'general').toLowerCase();
      if (src.includes('support')) return 'support';
      if (src.includes('builder')) return 'builder';
      if (src.includes('staff')) return 'staffer';
      if (src.includes('editor')) return 'editor';
      return src.replace(/[^a-z0-9]+/g, '-');
    })();
    const channelName = `ticket-${typeSlug}-${interaction.user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '');
    // Dedup: avoid doppio ticket se esiste già con lo stesso nome
    const existingByName = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === channelName
    ) as TextChannel | undefined;
    if (existingByName) {
      const msg = 'Esiste già un canale con questo nome: <#' + existingByName.id + '>';
      try {
        if (interaction.isRepliable() && !interaction.replied) {
          if (interaction.deferred) await interaction.editReply({ content: msg });
          else await interaction.reply({ ephemeral: true, content: msg });
        }
      } catch {}
      return null;
    }
    // Rate limit user
    this.rateLimitByUser.set(openerId, Date.now());

    channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId || undefined,
        permissionOverwrites: overwrites
      });

      await logEvent(this.dataDir, 'open', `Ticket ${channel.id} aperto da ${interaction.user.tag}`);

      const welcome = new EmbedBuilder()
        .setColor(this.config.embedTheme.color)
        .setTitle('Ticket aperto')
        .setDescription(preset?.welcomeMessage ?? this.config.defaultMessages.ticketWelcome)
        .setFooter({ text: this.config.embedTheme.footerText })
        .setTimestamp(new Date());
      const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_close')
          .setLabel(this.config.defaultMessages.closeButtonLabel || 'Chiudi Ticket')
          .setStyle(ButtonStyle.Danger)
      );
      const sent = await channel.send({ content: `<@${openerId}>`, embeds: [welcome], components: [closeRow] });
      
      // Use atomic update for index
      await this.atomicUpdateIndex(async (idx) => {
        idx.push({
          channelId: channel!.id,
          openerId,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          members: [openerId],
          welcomeMessageId: sent.id
        });
      });

      return `<#${channel.id}>`;
    } finally {
      if (fileLockAcquired) {
        await this.releaseFileLock(openerId).catch(() => {});
      }
      this.creatingByUser.delete(openerId);
      // Rispondi all'interazione se non è stata ancora gestita
      try {
        if (channel && interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ ephemeral: true, content: `Ticket creato: <#${channel.id}>` });
        } else if (channel && interaction.isRepliable() && interaction.deferred && !interaction.replied) {
          await interaction.editReply({ content: `Ticket creato: <#${channel.id}>` });
        }
      } catch (err: any) {
        if (err?.code === 40060 || err?.code === 10062) {
          // Already acknowledged or unknown interaction (e.g. another instance responded), ignore
        } else {
          console.error('Errore nel reply al ticket:', err);
        }
      }
    }
  }

  async closeTicket(
    channel: TextChannel,
    executor: User,
    reason?: string,
    options?: { statedClosedBy?: string; actualCloserId?: string; actualCloserTag?: string }
  ) {
    const statedClosedBy = options?.statedClosedBy;
    const actualCloserId = options?.actualCloserId ?? executor.id;
    const actualCloserTag = options?.actualCloserTag ?? executor.tag;

    // Atomic read-check-modify
    let entry: TicketIndexEntry | undefined;
    await this.atomicUpdateIndex(async (idx) => {
      entry = idx.find((e) => e.channelId === channel.id);
    });

    if (!entry) return false;

    if (entry.welcomeMessageId) {
      const msg = await channel.messages.fetch(entry.welcomeMessageId).catch(() => null);
      if (msg) {
        await msg.edit({ components: [] }).catch(() => {});
      }
    }

    const transcriptMsgs = await this.fetchTranscript(channel);
    const closeInfo: TranscriptCloseInfo = {
      statedClosedBy,
      actualCloserId,
      actualCloserTag
    };
    await writeTranscriptHtml(this.dataDir, channel.id, transcriptMsgs, closeInfo);
    const transcriptPath = path.join(this.dataDir, 'tickets', channel.id, 'transcript.html');

    let desc = this.config.defaultMessages.ticketClosed;
    if (statedClosedBy || reason) {
      const parts: string[] = [];
      if (statedClosedBy) parts.push(`Chiuso da: **${statedClosedBy}**`);
      if (reason) parts.push(`Motivo: ${reason}`);
      desc += '\n\n' + parts.join('\n');
    }
    const doneEmbed = new EmbedBuilder()
      .setColor(0xff6666)
      .setTitle('Ticket chiuso')
      .setDescription(desc)
      .setFooter({ text: this.config.embedTheme.footerText })
      .setTimestamp(new Date());
    await channel.send({ embeds: [doneEmbed] });

    // Move to archive and lock
    try {
      const archiveTarget = this.config.archiveCategoryId;
      const archiveParent = await this.resolveParentCategoryId(archiveTarget, channel.guild);
      if (archiveParent) {
        await channel.setParent(archiveParent);
      }
      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
        ViewChannel: false
      });
      for (const id of entry.members) {
        await channel.permissionOverwrites.delete(id).catch(() => {});
      }
      for (const id of this.config.staffRoleIds) {
        await channel.permissionOverwrites.edit(id, {
          ViewChannel: true,
          SendMessages: false,
          ReadMessageHistory: true
        });
      }
      await channel.setName(channel.name.replace(/^ticket-/, 'archivio-'));
    } catch (e) {
      await logEvent(this.dataDir, 'close-archive-error', `Ticket ${channel.id}: ${String(e)}`);
    }

    await logEvent(
      this.dataDir,
      'close',
      `Ticket ${channel.id} chiuso da ${executor.tag} (opener ${entry.openerId})`
    );

    // If archiveCategoryId points to a text channel, notify there with transcript attachment
    const archiveNotify = await this.resolveNotifyChannel(this.config.archiveCategoryId, channel.guild);
    if (archiveNotify) {
      const notifyEmbed = new EmbedBuilder()
        .setColor(0xffcc66)
        .setTitle('Ticket archiviato')
        .setDescription(`Canale: <#${channel.id}>\nOpener: <@${entry.openerId}>`)
        .setTimestamp(new Date())
        .setFooter({ text: this.config.embedTheme.footerText });
      const exists = await fs.pathExists(transcriptPath);
      if (exists) {
        const attachment = new AttachmentBuilder(transcriptPath, { name: `transcript-${channel.id}.html` });
        await archiveNotify.send({ embeds: [notifyEmbed], files: [attachment] });
      } else {
        await archiveNotify.send({ embeds: [notifyEmbed] });
      }
    }

    // Remove from index
    await this.atomicUpdateIndex((index) => {
      const i = index.findIndex((e) => e.channelId === channel.id);
      if (i !== -1) {
        index.splice(i, 1);
      }
    });
    return true;
  }

  async addUserToTicket(channel: TextChannel, user: User) {
    const exists = await this.getTicketEntry(channel.id);
    if (!exists) return false;

    await channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });
    
    await this.atomicUpdateIndex((idx) => {
      const entry = idx.find((e) => e.channelId === channel.id);
      if (entry && !entry.members.includes(user.id)) {
        entry.members.push(user.id);
      }
    });
    await logEvent(this.dataDir, 'member-add', `Utente ${user.tag} aggiunto al ticket ${channel.id}`);
    return true;
  }

  async removeUserFromTicket(channel: TextChannel, user: User) {
    const exists = await this.getTicketEntry(channel.id);
    if (!exists) return false;

    await channel.permissionOverwrites.delete(user.id).catch(() => {});
    
    await this.atomicUpdateIndex((idx) => {
      const entry = idx.find((e) => e.channelId === channel.id);
      if (entry) {
        entry.members = entry.members.filter((m) => m !== user.id);
      }
    });
    await logEvent(this.dataDir, 'member-remove', `Utente ${user.tag} rimosso dal ticket ${channel.id}`);
    return true;
  }

  async trackMessageIfTicket(message: any) {
    let tracked = false;
    await this.atomicUpdateIndex((idx) => {
      const entry = idx.find((e) => e.channelId === message.channel.id);
      if (entry) {
        entry.lastActiveAt = new Date().toISOString();
        tracked = true;
      }
    });
    if (!tracked) return;
    await appendTicketMessage(this.dataDir, message.channel.id, {
      id: message.id,
      authorId: message.author.id,
      authorTag: message.author.tag,
      content: message.content,
      createdAt: message.createdAt.toISOString()
    });
  }

  isUserRateLimited(userId: string): { remaining: number } | null {
    const last = this.rateLimitByUser.get(userId);
    if (!last) return null;
    const diffMs = Date.now() - last;
    const minutes = this.config.rateLimitMinutes;
    const remaining = Math.ceil((minutes * 60_000 - diffMs) / 60_000);
    if (diffMs >= minutes * 60_000) {
      this.rateLimitByUser.delete(userId);
      return null;
    }
    return { remaining: Math.max(0, remaining) };
  }

  startInactivityWatcher() {
    if (this.inactivityTimer) clearInterval(this.inactivityTimer);
    const hours = this.config.inactivityTimeoutHours;
    if (!hours || hours <= 0) return;
    const intervalMs = 5 * 60_000;
    const rateLimitMs = this.config.rateLimitMinutes * 60_000;
    this.inactivityTimer = setInterval(async () => {
      const now = Date.now();
      for (const [userId, last] of this.rateLimitByUser.entries()) {
        if (now - last >= rateLimitMs) this.rateLimitByUser.delete(userId);
      }
      const idx = await this.readIndex();
      for (const entry of idx) {
        const last = Date.parse(entry.lastActiveAt);
        const timeoutMs = hours * 60 * 60_000;
        if (now - last >= timeoutMs) {
          const channel = this.client.channels.cache.get(entry.channelId) as TextChannel | undefined;
          if (channel) {
            await this.closeTicket(channel, this.client.user!, 'Chiusura automatica per inattività');
          }
        }
      }
    }, intervalMs);
  }

  private async fetchTranscript(channel: TextChannel) {
    const out: Array<{
      id: string;
      authorTag: string;
      authorId: string;
      content: string;
      createdAt: string;
    }> = [];
    let lastId: string | undefined = undefined;
    while (true) {
      const batch = await channel.messages
        .fetch({ limit: 100, before: lastId })
        .catch(() => null) as import('discord.js').Collection<string, import('discord.js').Message> | null;
      if (!batch || batch.size === 0) break;
      for (const m of batch.values()) {
        out.push({
          id: m.id,
          authorTag: m.author.tag,
          authorId: m.author.id,
          content: m.content,
          createdAt: m.createdAt.toISOString()
        });
      }
      lastId = batch.last()?.id;
      if (!lastId) break;
    }
    out.reverse();
    return out;
  }

  private async atomicUpdateIndex(callback: (index: TicketIndexEntry[]) => Promise<void> | void) {
    const previousLock = this.indexLock;
    let releaseLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    // Chain the lock
    this.indexLock = newLock;

    // Wait for previous operation
    await previousLock;

    try {
      const idx = await this.readIndex();
      await callback(idx);
      await this.writeIndex(idx);
    } catch (err) {
      console.error('Error in atomicUpdateIndex:', err);
    } finally {
      releaseLock!();
    }
  }

  private async acquireFileLock(userId: string): Promise<boolean> {
    const lockFile = this.lockFilePath;
    const maxRetries = 10;
    for (let i = 0; i < maxRetries; i++) {
      try {
        await fs.ensureDir(path.dirname(lockFile));
        // Use 'wx' flag to fail if file exists
        const fd = await fs.open(lockFile, 'wx');
        await fs.write(fd, `${userId}:${Date.now()}`);
        await fs.close(fd);
        return true;
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // Check if stale (> 10 seconds)
          try {
            const stats = await fs.stat(lockFile);
            if (Date.now() - stats.mtimeMs > 10000) {
              await fs.remove(lockFile).catch(() => {});
              continue;
            }
          } catch {}
          // Wait random time between 50-200ms
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 150) + 50));
        } else {
          return false;
        }
      }
    }
    return false;
  }

  private async releaseFileLock(userId: string) {
    try {
      const lockFile = this.lockFilePath;
      if (await fs.pathExists(lockFile)) {
        // Only delete if it belongs to us (optional check, but good for safety)
        const content = await fs.readFile(lockFile, 'utf-8');
        if (content.startsWith(userId)) {
          await fs.remove(lockFile);
        }
      }
    } catch {}
  }

  private indexFile() {
    return path.join(this.dataDir, 'tickets', 'index.json');
  }

  private async readIndex(): Promise<TicketIndexEntry[]> {
    const file = this.indexFile();
    if (!(await fs.pathExists(file))) return [];
    return (await fs.readJSON(file)) as TicketIndexEntry[];
  }

  private async writeIndex(entries: TicketIndexEntry[]) {
    const file = this.indexFile();
    await fs.ensureDir(path.dirname(file));
    await fs.writeJSON(file, entries, { spaces: 2 });
  }

  async getTicketEntry(channelId: string): Promise<TicketIndexEntry | null> {
    // Read is safe without lock if we assume atomic writes by fs-extra, 
    // but for consistency we could lock. 
    // However, read-only doesn't strictly need lock if we don't mind stale data for a millisecond.
    // Let's keep it simple.
    const idx = await this.readIndex();
    return idx.find((e) => e.channelId === channelId) ?? null;
  }

  getMemberRoleIds(member: GuildMember | { roles?: string[] } | null): string[] {
    if (!member) return [];
    const m: any = member as any;
    if (m.roles?.cache) {
      return Array.from(m.roles.cache.keys());
    }
    if (Array.isArray(m.roles)) {
      return m.roles as string[];
    }
    return [];
  }

  private async resolveParentCategoryId(id: string | undefined, guild: import('discord.js').Guild) {
    if (!id) return undefined;
    const target = await guild.channels.fetch(id).catch(() => null);
    if (!target) return undefined;
    if (target.type === DjsChannelType.GuildCategory) return target.id;
    if (target.type === DjsChannelType.GuildText || target.type === DjsChannelType.GuildVoice || target.type === DjsChannelType.GuildAnnouncement) {
      return (target as any).parentId ?? undefined;
    }
    return undefined;
  }

  private async resolveNotifyChannel(id: string | undefined, guild: import('discord.js').Guild): Promise<TextChannel | null> {
    if (!id) return null;
    const target = await guild.channels.fetch(id).catch(() => null);
    if (!target) return null;
    if (target.type === DjsChannelType.GuildText) return target as TextChannel;
    return null;
  }
}
