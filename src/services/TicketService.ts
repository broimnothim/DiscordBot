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
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs-extra';
import path from 'path';
import { appendTicketMessage, logEvent, writeTranscriptHtml } from './Logger.js';

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
      .addFields(theme.fields)
      .setTimestamp(new Date())
      .setFooter({ text: theme.footerText });
    if (theme.thumbnailUrl) {
      embed.setThumbnail(theme.thumbnailUrl);
    }
    return embed;
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

  async createTicket(interaction: Interaction, preset?: ButtonPreset) {
    if (!interaction.guild || !interaction.user) return null;
    const guild = interaction.guild;
    const target = preset?.targetId ?? this.config.ticketCategoryId;
    const categoryId = await this.resolveParentCategoryId(target, guild);
    const openerId = interaction.user.id;

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
      return `<#${existingByName.id}>`;
    }
    // Dedup: evita secondo ticket se l'utente ha già un ticket aperto
    const idx0 = await this.readIndex();
    const existingByOpener = idx0.find((e) => e.openerId === openerId);
    if (existingByOpener) {
      const ch = await guild.channels.fetch(existingByOpener.channelId).catch(() => null);
      if (ch && (ch as any).type === ChannelType.GuildText) {
        return `<#${existingByOpener.channelId}>`;
      }
    }
    // Rate limit user
    this.rateLimitByUser.set(openerId, Date.now());

    const channel = await guild.channels.create({
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
    await this.writeIndexEntry({
      channelId: channel.id,
      openerId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      members: [openerId],
      welcomeMessageId: sent.id
    });

    return `<#${channel.id}>`;
  }

  async closeTicket(channel: TextChannel, executor: User, reason?: string) {
    const idx = await this.readIndex();
    const entry = idx.find((e) => e.channelId === channel.id);
    if (!entry) return false;

    if (entry.welcomeMessageId) {
      const msg = await channel.messages.fetch(entry.welcomeMessageId).catch(() => null);
      if (msg) {
        await msg.edit({ components: [] }).catch(() => {});
      }
    }

    const transcriptMsgs = await this.fetchTranscript(channel);
    await writeTranscriptHtml(this.dataDir, channel.id, transcriptMsgs);
    const transcriptPath = path.join(this.dataDir, 'tickets', channel.id, 'transcript.html');

    const doneEmbed = new EmbedBuilder()
      .setColor(0xff6666)
      .setTitle('Ticket chiuso')
      .setDescription(this.config.defaultMessages.ticketClosed + (reason ? `\nMotivo: ${reason}` : ''))
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
    } catch {}

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
    await this.writeIndex(idx.filter((e) => e.channelId !== channel.id));
    return true;
  }

  async addUserToTicket(channel: TextChannel, user: User) {
    const idx = await this.readIndex();
    const entry = idx.find((e) => e.channelId === channel.id);
    if (!entry) return false;
    await channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });
    if (!entry.members.includes(user.id)) {
      entry.members.push(user.id);
      await this.writeIndex(idx);
    }
    await logEvent(this.dataDir, 'member-add', `Utente ${user.tag} aggiunto al ticket ${channel.id}`);
    return true;
  }

  async removeUserFromTicket(channel: TextChannel, user: User) {
    const idx = await this.readIndex();
    const entry = idx.find((e) => e.channelId === channel.id);
    if (!entry) return false;
    await channel.permissionOverwrites.delete(user.id).catch(() => {});
    entry.members = entry.members.filter((m) => m !== user.id);
    await this.writeIndex(idx);
    await logEvent(this.dataDir, 'member-remove', `Utente ${user.tag} rimosso dal ticket ${channel.id}`);
    return true;
  }

  async trackMessageIfTicket(message: any) {
    const idx = await this.readIndex();
    const entry = idx.find((e) => e.channelId === message.channel.id);
    if (!entry) return;
    entry.lastActiveAt = new Date().toISOString();
    await this.writeIndex(idx);
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
    this.inactivityTimer = setInterval(async () => {
      const idx = await this.readIndex();
      const now = Date.now();
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

  private async writeIndexEntry(entry: TicketIndexEntry) {
    const idx = await this.readIndex();
    idx.push(entry);
    await this.writeIndex(idx);
  }

  async getTicketEntry(channelId: string): Promise<TicketIndexEntry | null> {
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
