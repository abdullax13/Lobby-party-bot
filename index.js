const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  Events
} = require("discord.js");

// ====== CONFIG (Railway ENV) ======
const TOKEN = process.env.DISCORD_TOKEN;

// اختياري: تحدد القيم هنا بالـ ENV بعدين
const SETUP_GUILD_ID = process.env.GUILD_ID || "";
const SETUP_CHANNEL_ID = process.env.SETUP_CHANNEL_ID || "";

// ====== DATA FILE ======
const DATA_PATH = path.join(__dirname, "data.json");

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch (e) {
    return {
      setup: { guildId: "", channelId: "", messageId: "" },
      lobbies: { MLBB: [], CODM: [] }
    };
  }
}
function writeData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function nowTs() {
  return Date.now();
}

// ====== UI HELPERS ======
function mainEmbed(guildName) {
  return new EmbedBuilder()
    .setTitle(guildName || "[Rising Flames]")
    .setDescription("اضغط واختر اللعبة ثم سوِّ لوبي أو دوّر لاعبين.")
    .setFooter({ text: "Lobby / Party System" });
}

function mainRow() {
  const select = new StringSelectMenuBuilder()
    .setCustomId("game_select")
    .setPlaceholder("اختَر لعبة")
    .addOptions(
      { label: "MOBILE LEGENDS", value: "MLBB" },
      { label: "CALL OF DUTY MOBILE", value: "CODM" }
    );

  return new ActionRowBuilder().addComponents(select);
}

function gameMenuEmbed(gameKey) {
  const title = gameKey === "MLBB" ? "MOBILE LEGENDS" : "CALL OF DUTY MOBILE";
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription("اختَر إجراء:")
    .setFooter({ text: "Create Lobby / Find Players" });
}

function gameRow(gameKey) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`create_lobby:${gameKey}`)
      .setLabel("Create Lobby")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`find_players:${gameKey}`)
      .setLabel("Find Players")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("back_to_main")
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary)
  );
}

function statusEmoji(lobby) {
  if (lobby.locked) return "🔒";
  if (lobby.members.length >= 5) return "🔴";
  return "🟢";
}

function findEmbed(gameKey, lobbies) {
  const title = gameKey === "MLBB" ? "Find Players — MOBILE LEGENDS" : "Find Players — CALL OF DUTY MOBILE";

  const lines = lobbies.length
    ? lobbies.map((l, i) => {
        const count = `${l.members.length}/5`;
        return `${i + 1}) ${statusEmoji(l)} <#${l.channelId}> — **${count}**`;
      })
    : ["ماكو لوبيات حالياً."];

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "اختَر روم للانضمام" });
}

function lobbyJoinSelect(gameKey, lobbies) {
  const options = lobbies.slice(0, 25).map((l) => {
    const count = `${l.members.length}/5`;
    const label = `${statusEmoji(l)} ${count}`;
    return {
      label,
      value: `join:${gameKey}:${l.channelId}`,
      description: `انضم إلى ${l.channelName || "Lobby"}`
    };
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`join_menu:${gameKey}`)
    .setPlaceholder(lobbies.length ? "اختَر لوبي" : "ماكو لوبيات")
    .setDisabled(!lobbies.length)
    .addOptions(options.length ? options : [{ label: "N/A", value: "na" }]);

  return new ActionRowBuilder().addComponents(menu);
}

function ownerControlsRow(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lobby_lock:${channelId}`)
      .setLabel("Lock/Unlock")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`lobby_delete:${channelId}`)
      .setLabel("Delete")
      .setStyle(ButtonStyle.Danger)
  );
}

// ====== DISCORD CLIENT ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

// ====== SETUP MESSAGE (FIXED EMBED) ======
async function ensureSetupMessage() {
  const data = readData();

  const guildId = data.setup.guildId || SETUP_GUILD_ID;
  const channelId = data.setup.channelId || SETUP_CHANNEL_ID;

  if (!guildId || !channelId) {
    console.log("Setup skipped: set GUILD_ID and SETUP_CHANNEL_ID in Railway env, or fill data.json setup.");
    return;
  }

  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);

  if (!channel || !channel.isTextBased()) {
    console.log("Setup channel invalid.");
    return;
  }

  // If message exists, try to fetch it
  if (data.setup.messageId) {
    try {
      const msg = await channel.messages.fetch(data.setup.messageId);
      // Update embed title with current guild name (optional)
      await msg.edit({ embeds: [mainEmbed(guild.name)], components: [mainRow()] });
      console.log("Setup message updated.");
      return;
    } catch (e) {
      console.log("Setup message not found, will create new one.");
    }
  }

  const sent = await channel.send({ embeds: [mainEmbed(guild.name)], components: [mainRow()] });
  data.setup.guildId = guildId;
  data.setup.channelId = channelId;
  data.setup.messageId = sent.id;
  writeData(data);
  console.log("Setup message created.");
}

// ====== LOBBY HELPERS ======
async function getOrCreateCategory(guild, name) {
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name
  );
  if (existing) return existing;

  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory
  });
}

function findLobbyByChannelId(data, channelId) {
  for (const gameKey of ["MLBB", "CODM"]) {
    const idx = data.lobbies[gameKey].findIndex((l) => l.channelId === channelId);
    if (idx !== -1) return { gameKey, idx, lobby: data.lobbies[gameKey][idx] };
  }
  return null;
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch {}
}

// ====== EVENTS ======
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Cache guild channels for category lookup
  for (const g of client.guilds.cache.values()) {
    await g.channels.fetch().catch(() => {});
  }
  await ensureSetupMessage();
});

client.on(Events.InteractionCreate, async (interaction) => {
  const data = readData();

  // ====== GAME SELECT (MAIN EMBED) ======
  if (interaction.isStringSelectMenu() && interaction.customId === "game_select") {
    const gameKey = interaction.values[0];

    return safeReply(interaction, {
      ephemeral: true,
      embeds: [gameMenuEmbed(gameKey)],
      components: [gameRow(gameKey)]
    });
  }

  // ====== BACK BUTTON ======
  if (interaction.isButton() && interaction.customId === "back_to_main") {
    return safeReply(interaction, {
      ephemeral: true,
      embeds: [mainEmbed(interaction.guild?.name || "[Rising Flames]")],
      components: [mainRow()]
    });
  }

  // ====== CREATE LOBBY BUTTON -> MODAL ======
  if (interaction.isButton() && interaction.customId.startsWith("create_lobby:")) {
    const gameKey = interaction.customId.split(":")[1];

    const modal = new ModalBuilder()
      .setCustomId(`create_modal:${gameKey}`)
      .setTitle("Create Lobby");

    const idInput = new TextInputBuilder()
      .setCustomId("player_id")
      .setLabel("حط آيديك داخل اللعبة")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(50);

    modal.addComponents(new ActionRowBuilder().addComponents(idInput));
    return interaction.showModal(modal);
  }

  // ====== MODAL SUBMIT -> CREATE CHANNEL ======
  if (interaction.isModalSubmit() && interaction.customId.startsWith("create_modal:")) {
    const gameKey = interaction.customId.split(":")[1];
    const playerId = interaction.fields.getTextInputValue("player_id").trim();

    const guild = interaction.guild;
    if (!guild) return;

    // Category per game
    const catName = gameKey === "MLBB" ? "LOBBIES-MLBB" : "LOBBIES-CODM";
    const category = await getOrCreateCategory(guild, catName);

    // Channel name
    const base = gameKey === "MLBB" ? "mlbb" : "codm";
    const chanName = `${base}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, "");

    // Create private temp channel
    const ch = await guild.channels.create({
      name: chanName.slice(0, 90),
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel]
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory
          ]
        },
        {
          id: client.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.ManageMessages,
            PermissionsBitField.Flags.ReadMessageHistory
          ]
        }
      ]
    });

    // Save lobby
    const lobby = {
      channelId: ch.id,
      channelName: ch.name,
      ownerId: interaction.user.id,
      ownerTag: interaction.user.tag,
      gameKey,
      playerId,
      locked: false,
      members: [interaction.user.id],
      createdAt: nowTs()
    };

    data.lobbies[gameKey].push(lobby);
    writeData(data);

    // Post owner controls inside lobby
    const info = new EmbedBuilder()
      .setTitle("Lobby Created")
      .setDescription(
        `المالك: <@${interaction.user.id}>\n` +
        `Game: **${gameKey}**\n` +
        `Player ID: **${playerId}**\n\n` +
        `الحد: **5**\n` +
        `تقدر تقفل/تفتح أو تحذف اللوبي من الأزرار تحت.`
      );

    await ch.send({ embeds: [info], components: [ownerControlsRow(ch.id)] });

    return safeReply(interaction, {
      ephemeral: true,
      content: `تم إنشاء اللوبي: <#${ch.id}> ✅`
    });
  }

  // ====== FIND PLAYERS BUTTON ======
  if (interaction.isButton() && interaction.customId.startsWith("find_players:")) {
    const gameKey = interaction.customId.split(":")[1];
    const lobbies = data.lobbies[gameKey] || [];

    return safeReply(interaction, {
      ephemeral: true,
      embeds: [findEmbed(gameKey, lobbies)],
      components: [lobbyJoinSelect(gameKey, lobbies)]
    });
  }

  // ====== JOIN MENU SELECT ======
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("join_menu:")) {
    const gameKey = interaction.customId.split(":")[1];
    const val = interaction.values[0];
    if (val === "na") return safeReply(interaction, { ephemeral: true, content: "ماكو لوبيات." });

    const parts = val.split(":"); // join:GAME:channelId
    const channelId = parts[2];

    const lobbyIdx = (data.lobbies[gameKey] || []).findIndex((l) => l.channelId === channelId);
    if (lobbyIdx === -1) return safeReply(interaction, { ephemeral: true, content: "اللوبي هذا اختفى." });

    const lobby = data.lobbies[gameKey][lobbyIdx];

    if (lobby.locked) return safeReply(interaction, { ephemeral: true, content: "اللوبي مقفّل 🔒" });
    if (lobby.members.length >= 5) return safeReply(interaction, { ephemeral: true, content: "اللوبي ممتلئ 🔴" });

    if (lobby.members.includes(interaction.user.id)) {
      return safeReply(interaction, { ephemeral: true, content: `أنت أصلاً داخل <#${channelId}>.` });
    }

    const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!ch) return safeReply(interaction, { ephemeral: true, content: "الروم غير موجود." });

    // grant access
    await ch.permissionOverwrites.edit(interaction.user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });

    lobby.members.push(interaction.user.id);
    writeData(data);

    await ch.send(`انضم <@${interaction.user.id}> ✅  (${lobby.members.length}/5)`);

    return safeReply(interaction, {
      ephemeral: true,
      content: `تم إدخالك <#${channelId}> ✅`
    });
  }

  // ====== OWNER CONTROLS: LOCK/UNLOCK ======
  if (interaction.isButton() && interaction.customId.startsWith("lobby_lock:")) {
    const channelId = interaction.customId.split(":")[1];
    const found = findLobbyByChannelId(data, channelId);
    if (!found) return safeReply(interaction, { ephemeral: true, content: "اللوبي غير موجود بالبيانات." });

    const { gameKey, idx, lobby } = found;
    if (interaction.user.id !== lobby.ownerId) {
      return safeReply(interaction, { ephemeral: true, content: "بس مالك اللوبي يقدر يقفل/يفتح." });
    }

    lobby.locked = !lobby.locked;
    data.lobbies[gameKey][idx] = lobby;
    writeData(data);

    return safeReply(interaction, {
      ephemeral: true,
      content: lobby.locked ? "تم قفل اللوبي 🔒" : "تم فتح اللوبي 🟢"
    });
  }

  // ====== OWNER CONTROLS: DELETE ======
  if (interaction.isButton() && interaction.customId.startsWith("lobby_delete:")) {
    const channelId = interaction.customId.split(":")[1];
    const found = findLobbyByChannelId(data, channelId);
    if (!found) return safeReply(interaction, { ephemeral: true, content: "اللوبي غير موجود." });

    const { gameKey, idx, lobby } = found;
    if (interaction.user.id !== lobby.ownerId) {
      return safeReply(interaction, { ephemeral: true, content: "بس مالك اللوبي يقدر يحذفه." });
    }

    // remove from data
    data.lobbies[gameKey].splice(idx, 1);
    writeData(data);

    // delete channel
    const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (ch) await ch.delete("Lobby deleted by owner").catch(() => {});

    return safeReply(interaction, { ephemeral: true, content: "تم حذف اللوبي 🗑️" });
  }
});

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment variables.");
  process.exit(1);
}

client.login(TOKEN);
