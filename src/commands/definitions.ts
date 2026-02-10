import { SlashCommandBuilder } from 'discord.js';

export type PanelChoice = { name: string; value: string };

export function getCommands(panelChoices: PanelChoice[]) {
  return [
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
      .addUserOption((opt) => opt.setName('user').setDescription('Utente da rimuovere').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('autorole-set')
      .setDescription('Imposta il ruolo da assegnare automaticamente ai nuovi membri.')
      .addRoleOption((opt) => opt.setName('role').setDescription('Il ruolo da assegnare').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('welcome-set')
      .setDescription('Imposta il canale e il messaggio di benvenuto.')
      .addChannelOption((opt) => opt.setName('channel').setDescription('Canale per i messaggi di benvenuto').setRequired(true))
      .addStringOption((opt) =>
        opt.setName('message').setDescription('Messaggio di benvenuto ({user} = menzione, {count} = membri).').setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('staffrole')
      .setDescription('Imposta i ruoli staff che possono vedere e gestire i ticket.')
      .addSubcommand((sc) =>
        sc
          .setName('set')
          .setDescription('Imposta la lista dei ruoli staff (sostituisce quella attuale).')
          .addRoleOption((o) => o.setName('role1').setDescription('Ruolo staff').setRequired(true))
          .addRoleOption((o) => o.setName('role2').setDescription('Secondo ruolo (opzionale)').setRequired(false))
          .addRoleOption((o) => o.setName('role3').setDescription('Terzo ruolo (opzionale)').setRequired(false))
          .addRoleOption((o) => o.setName('role4').setDescription('Quarto ruolo (opzionale)').setRequired(false))
          .addRoleOption((o) => o.setName('role5').setDescription('Quinto ruolo (opzionale)').setRequired(false))
      )
      .addSubcommand((sc) => sc.setName('list').setDescription('Mostra i ruoli staff attuali.'))
      .toJSON()
  ];
}
