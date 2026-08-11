const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  AttachmentBuilder
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration
  ]
});

const OWNER_ID = "1515531454967447572";
const PREFIX = "!";

// ─── Anti-spam: rastreo de mensajes ───────────────────────────────────────
const spamTracker = new Map(); // userId -> [timestamps]
const SPAM_THRESHOLD = 10;    // mensajes en...
const SPAM_WINDOW = 5000;     // ...5 segundos = spam

// ─── Anti-raid: rastreo de entradas ───────────────────────────────────────
const joinTracker = new Map();
const RAID_THRESHOLD = 5;
const RAID_WINDOW = 8000;
const raidMode = new Map();

function soloOwner(msg) {
  return msg.author.id === OWNER_ID;
}

function log(guild, descripcion, color = 0xFF4444) {
  const embed = new EmbedBuilder()
    .setTitle("🛡️ Anti-Raid Log")
    .setDescription(descripcion)
    .setColor(color)
    .setTimestamp();

  const canal = guild.channels.cache.find(c =>
    ["logs", "raid-logs", "mod-logs", "registros"].includes(c.name) &&
    c.type === ChannelType.GuildText
  );
  if (canal) canal.send({ embeds: [embed] }).catch(() => {});
}

// ─── BACKUP ───────────────────────────────────────────────────────────────
async function hacerBackup(guild) {
  const backup = {
    nombre: guild.name,
    icono: guild.iconURL({ size: 512, extension: "png" }),
    roles: [],
    categorias: [],
    canales: []
  };

  guild.roles.cache
    .filter(r => r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .forEach(r => {
      backup.roles.push({
        nombre: r.name,
        color: r.hexColor,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permisos: r.permissions.bitfield.toString(),
        posicion: r.position
      });
    });

  guild.channels.cache
    .filter(c => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position)
    .forEach(cat => {
      const permisos = [];
      cat.permissionOverwrites.cache.forEach(ow => {
        permisos.push({
          id: ow.id,
          tipo: ow.type,
          allow: ow.allow.bitfield.toString(),
          deny: ow.deny.bitfield.toString()
        });
      });
      backup.categorias.push({
        id: cat.id,
        nombre: cat.name,
        posicion: cat.position,
        permisos
      });
    });

  guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice)
    .sort((a, b) => a.position - b.position)
    .forEach(c => {
      const permisos = [];
      c.permissionOverwrites.cache.forEach(ow => {
        permisos.push({
          id: ow.id,
          tipo: ow.type,
          allow: ow.allow.bitfield.toString(),
          deny: ow.deny.bitfield.toString()
        });
      });
      backup.canales.push({
        nombre: c.name,
        tipo: c.type,
        categoriaId: c.parentId ?? null,
        posicion: c.position,
        tema: c.topic ?? null,
        nsfw: c.nsfw ?? false,
        slowmode: c.rateLimitPerUser ?? 0,
        permisos
      });
    });

  return backup;
}

async function restaurarBackup(guild, backup, msg) {
  const progreso = await msg.channel.send("⏳ Restaurando backup...");

  try {
    await guild.setName(backup.nombre).catch(() => {});
    await progreso.edit("✅ Nombre restaurado. Eliminando roles...");

    for (const rol of guild.roles.cache.values()) {
      if (rol.id === guild.id) continue;
      if (rol.managed) continue;
      if (rol.position >= guild.members.me.roles.highest.position) continue;
      await rol.delete().catch(() => {});
    }

    for (const r of backup.roles) {
      try {
        await guild.roles.create({
          name: r.nombre,
          color: r.color,
          hoist: r.hoist,
          mentionable: r.mentionable,
          permissions: BigInt(r.permisos)
        });
      } catch {}
    }

    await progreso.edit("✅ Roles creados. Eliminando canales...");

    for (const canal of guild.channels.cache.values()) {
      await canal.delete().catch(() => {});
    }

    const mapaCategorias = new Map();
    for (const cat of backup.categorias) {
      try {
        const nueva = await guild.channels.create({
          name: cat.nombre,
          type: ChannelType.GuildCategory,
          position: cat.posicion,
          permissionOverwrites: cat.permisos.map(p => ({
            id: p.id,
            allow: BigInt(p.allow),
            deny: BigInt(p.deny)
          }))
        });
        mapaCategorias.set(cat.id, nueva);
      } catch {}
    }

    for (const c of backup.canales) {
      try {
        const opciones = {
          name: c.nombre,
          type: c.tipo,
          position: c.posicion,
          nsfw: c.nsfw,
          rateLimitPerUser: c.slowmode,
          permissionOverwrites: c.permisos.map(p => ({
            id: p.id,
            allow: BigInt(p.allow),
            deny: BigInt(p.deny)
          }))
        };
        if (c.tema) opciones.topic = c.tema;
        if (c.categoriaId && mapaCategorias.has(c.categoriaId)) {
          opciones.parent = mapaCategorias.get(c.categoriaId);
        }
        await guild.channels.create(opciones);
      } catch {}
    }

    await progreso.edit("✅ ¡Backup restaurado completamente!");
  } catch (e) {
    await progreso.edit(`❌ Error: ${e.message}`);
  }
}

// ─── Lockdown ─────────────────────────────────────────────────────────────
async function activarLockdown(guild) {
  raidMode.set(guild.id, true);
  const everyone = guild.roles.everyone;
  for (const canal of guild.channels.cache.values()) {
    if (canal.type !== ChannelType.GuildText) continue;
    await canal.permissionOverwrites.edit(everyone, { SendMessages: false }).catch(() => {});
  }
  log(guild, "🔒 **LOCKDOWN ACTIVADO** — Raid detectado.", 0xFF0000);
}

async function desactivarLockdown(guild) {
  raidMode.set(guild.id, false);
  const everyone = guild.roles.everyone;
  for (const canal of guild.channels.cache.values()) {
    if (canal.type !== ChannelType.GuildText) continue;
    await canal.permissionOverwrites.edit(everyone, { SendMessages: null }).catch(() => {});
  }
  log(guild, "🔓 **LOCKDOWN DESACTIVADO** — Servidor normal.", 0x00FF88);
}

// ─── Evento: miembro entra ────────────────────────────────────────────────
client.on("guildMemberAdd", async (member) => {
  const { guild } = member;

  // Bots: no banear automáticamente, solo monitorear por spam
  if (member.user.bot) {
    log(guild, `🤖 Bot **${member.user.tag}** entró al servidor. Será expulsado si hace spam.`, 0xFFFF00);
    return;
  }

  // Rastrear entradas rápidas de usuarios
  const ahora = Date.now();
  if (!joinTracker.has(guild.id)) joinTracker.set(guild.id, []);
  const entradas = joinTracker.get(guild.id);
  entradas.push(ahora);

  const recientes = entradas.filter(t => ahora - t < RAID_WINDOW);
  joinTracker.set(guild.id, recientes);

  if (recientes.length >= RAID_THRESHOLD && !raidMode.get(guild.id)) {
    await activarLockdown(guild);

    const recienEntrados = guild.members.cache
      .filter(m => !m.user.bot && (ahora - m.joinedTimestamp) < RAID_WINDOW)
      .sort((a, b) => b.joinedTimestamp - a.joinedTimestamp);

    for (const [, m] of recienEntrados) {
      await m.kick("Anti-raid: entrada masiva detectada").catch(() => {});
    }

    log(guild, `⚠️ **RAID DETECTADO** — ${recientes.length} usuarios en ${RAID_WINDOW / 1000}s.`, 0xFF0000);
  }
});

// ─── Mensajes ─────────────────────────────────────────────────────────────
client.on("messageCreate", async (msg) => {
  if (!msg.guild) return;

  const ahora = Date.now();
  const userId = msg.author.id;
  const esBot = msg.author.bot;

  // ─── Anti-spam (aplica a bots Y usuarios) ───────────────────────────────
  if (!soloOwner(msg)) {
    if (!spamTracker.has(userId)) spamTracker.set(userId, []);
    const mensajes = spamTracker.get(userId);
    mensajes.push(ahora);

    const recientes = mensajes.filter(t => ahora - t < SPAM_WINDOW);
    spamTracker.set(userId, recientes);

    if (recientes.length >= SPAM_THRESHOLD) {
      spamTracker.set(userId, []); // resetear contador

      if (esBot) {
        // Bot haciendo spam → expulsar
        const miembro = msg.guild.members.cache.get(userId);
        if (miembro) {
          await miembro.kick("Anti-spam: bot haciendo spam").catch(() => {});
          log(msg.guild, `🤖 Bot **${msg.author.tag}** expulsado por spam (+${SPAM_THRESHOLD} mensajes en ${SPAM_WINDOW / 1000}s).`, 0xFF6600);
        }
        return;
      } else {
        // Usuario haciendo spam → aislamiento 10 minutos
        if (!msg.member?.permissions.has(PermissionFlagsBits.Administrator)) {
          await msg.member?.timeout(10 * 60 * 1000, "Anti-spam: demasiados mensajes").catch(() => {});
          log(msg.guild, `🔇 **${msg.author.tag}** aislado 10 min por spam (+${SPAM_THRESHOLD} mensajes en ${SPAM_WINDOW / 1000}s).`, 0xFF8800);
          return;
        }
      }
    }
  }

  if (esBot) return; // Los bots no pueden usar comandos

  // ─── Anti menciones masivas ──────────────────────────────────────────────
  const menciones = msg.mentions.users.size + msg.mentions.roles.size;
  if (menciones >= 5 || msg.mentions.everyone) {
    if (!msg.member?.permissions.has(PermissionFlagsBits.Administrator)) {
      await msg.delete().catch(() => {});
      await msg.member?.timeout(10 * 60 * 1000, "Anti-raid: menciones masivas").catch(() => {});
      log(msg.guild, `📢 **${msg.author.tag}** aislado 10 min por menciones masivas.`, 0xFF8800);
      return;
    }
  }

  if (!msg.content.startsWith(PREFIX)) return;
  if (!soloOwner(msg)) return msg.reply("❌ Solo el owner puede usar estos comandos.");

  const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args[0].toLowerCase();

  if (cmd === "backup") {
    await msg.reply("⏳ Generando backup...");
    const backup = await hacerBackup(msg.guild);
    const buffer = Buffer.from(JSON.stringify(backup, null, 2), "utf-8");
    const archivo = new AttachmentBuilder(buffer, { name: `backup_${msg.guild.name}_${Date.now()}.json` });
    await msg.channel.send({ content: "✅ Backup generado.", files: [archivo] });
    return;
  }

  if (cmd === "restore") {
    if (msg.attachments.size === 0) return msg.reply("❌ Adjuntá el archivo `.json`.");
    const archivo = msg.attachments.first();
    if (!archivo.name.endsWith(".json")) return msg.reply("❌ El archivo debe ser `.json`.");
    try {
      const res = await fetch(archivo.url);
      const backup = JSON.parse(await res.text());
      await restaurarBackup(msg.guild, backup, msg);
    } catch {
      msg.reply("❌ Error al leer el backup.");
    }
    return;
  }

  if (cmd === "lockdown") {
    if (raidMode.get(msg.guild.id)) {
      await desactivarLockdown(msg.guild);
      msg.reply("🔓 Lockdown desactivado.");
    } else {
      await activarLockdown(msg.guild);
      msg.reply("🔒 Lockdown activado.");
    }
    return;
  }

  if (cmd === "status") {
    const modo = raidMode.get(msg.guild.id) ? "🔒 LOCKDOWN ACTIVO" : "✅ Normal";
    const embed = new EmbedBuilder()
      .setTitle("🛡️ Estado del Anti-Raid")
      .addFields(
        { name: "Modo actual", value: modo },
        { name: "Umbral de raid", value: `${RAID_THRESHOLD} usuarios en ${RAID_WINDOW / 1000}s` },
        { name: "Umbral de spam", value: `${SPAM_THRESHOLD} mensajes en ${SPAM_WINDOW / 1000}s` }
      )
      .setColor(0x5865F2);
    msg.reply({ embeds: [embed] });
    return;
  }

  if (cmd === "ayuda") {
    const embed = new EmbedBuilder()
      .setTitle("🛡️ Comandos Anti-Raid")
      .addFields(
        { name: "!backup", value: "Genera un backup del servidor (.json)" },
        { name: "!restore + archivo.json", value: "Restaura el servidor desde un backup" },
        { name: "!lockdown", value: "Activa o desactiva el lockdown" },
        { name: "!status", value: "Muestra el estado del anti-raid" }
      )
      .setColor(0x5865F2);
    msg.reply({ embeds: [embed] });
  }
});

client.on("ready", () => {
  console.log(`✅ Anti-Raid Bot listo como ${client.user.tag}`);
});

client.login(process.env.TOKEN);
