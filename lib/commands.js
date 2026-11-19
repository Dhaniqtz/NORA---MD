"use strict";

const pino = require("pino");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");

const config = require("../config");
const settings = require("./settings");
const session = require("./session");

const SILENT_LOGGER = pino({ level: "silent" });

const CATEGORY_ORDER = ["general", "presence", "status", "media", "owner"];
const registry = new Map();

function register(name, definition) {
  registry.set(name, definition);
}

function formatUptime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function maskNumber(raw) {
  const digits = String(raw || "").split("@")[0].split(":")[0].replace(/\D/g, "");
  if (digits.length < 7) return null;
  return `${digits.slice(0, 3)}${"•".repeat(digits.length - 7)}${digits.slice(-4)}`;
}

function normalizeJid(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  return `${digits}@s.whatsapp.net`;
}

function contextInfo(message) {
  if (!message) return null;

  const keys = [
    "extendedTextMessage",
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage",
    "stickerMessage"
  ];

  for (const key of keys) {
    if (message[key] && message[key].contextInfo) return message[key].contextInfo;
  }

  return null;
}

function isViewOnce(message) {
  if (!message) return false;

  return Boolean(
    message.viewOnceMessage ||
      message.viewOnceMessageV2 ||
      message.viewOnceMessageV2Extension ||
      message.imageMessage?.viewOnce ||
      message.videoMessage?.viewOnce ||
      message.audioMessage?.viewOnce
  );
}

function targetJid(ctx) {
  const info = contextInfo(ctx.msg.message);

  if (info?.participant) return info.participant;
  if (info?.mentionedJid?.length) return info.mentionedJid[0];

  return ctx.sender;
}

// ---------------------------------------------------------------- general

register("menu", {
  category: "general",
  description: "Show every command grouped by category.",
  ownerOnly: false,
  async run(ctx) {
    let text = `❄️ *${config.BOT_NAME} — COMMAND CENTER*\n`;

    for (const category of CATEGORY_ORDER) {
      const entries = [...registry.entries()].filter(
        ([, def]) => def.category === category
      );

      if (!entries.length) continue;

      text += `\n*${category.toUpperCase()}*\n`;
      for (const [name, def] of entries) {
        const usage = def.usage ? ` ${def.usage}` : "";
        const lock = def.ownerOnly ? " 🔒" : "";
        text += `• ${config.PREFIX}${name}${usage}${lock} — ${def.description}\n`;
      }
    }

    text += `\nPrefix: *${config.PREFIX}* · 🔒 = owner only`;

    return ctx.reply(text);
  }
});

register("help", {
  category: "general",
  description: "Alias for .menu.",
  ownerOnly: false,
  run: (ctx) => registry.get("menu").run(ctx)
});

register("ping", {
  category: "general",
  description: "Check that NORA MD responds.",
  ownerOnly: false,
  async run(ctx) {
    const started = Date.now();
    await ctx.reply(`❄️ Pong — ${Date.now() - started}ms`);
  }
});

register("alive", {
  category: "general",
  description: "Show that the bot is running.",
  ownerOnly: false,
  async run(ctx) {
    const state = ctx.botApi.getStatus();
    await ctx.reply(
      `🤍 *${config.BOT_NAME} is alive*\n` +
        `Status: ${state.status.toUpperCase()}\n` +
        `Uptime: ${formatUptime(state.uptimeSeconds)}`
    );
  }
});

register("runtime", {
  category: "general",
  description: "Show how long the bot has been running.",
  ownerOnly: false,
  async run(ctx) {
    const state = ctx.botApi.getStatus();
    await ctx.reply(
      `⏱ Runtime: *${formatUptime(state.uptimeSeconds)}*\n` +
        `Connection: ${state.status.toUpperCase()}`
    );
  }
});

register("owner", {
  category: "general",
  description: "Show the bot owner.",
  ownerOnly: false,
  async run(ctx) {
    const number = maskNumber(config.OWNER_NUMBER) || "this account";
    await ctx.reply(`👑 Owner: *${config.OWNER_NAME}* (${number})`);
  }
});

register("status", {
  category: "general",
  description: "Connection, session and automation status.",
  ownerOnly: false,
  async run(ctx) {
    const state = ctx.botApi.getStatus();
    const stored = session.read();
    const current = settings.get();

    await ctx.reply(
      `❄️ *${config.BOT_NAME} STATUS*\n` +
        `Connection: ${state.status.toUpperCase()}\n` +
        `Session: ${stored.state.replace(/_/g, " ").toUpperCase()}\n` +
        `Registered: ${stored.registered ? "yes" : "no"}\n` +
        `Uptime: ${formatUptime(state.uptimeSeconds)}\n` +
        `Auto view status: ${current.statusView ? "on" : "off"}\n` +
        `Auto react status: ${current.statusReact ? "on" : "off"}`
    );
  }
});

// ---------------------------------------------------------------- presence

register("online", {
  category: "presence",
  usage: "",
  description: "Set the account presence to online.",
  ownerOnly: true,
  async run(ctx) {
    await settings.update({ presence: "available" });
    await ctx.socket.sendPresenceUpdate("available");
    await ctx.reply("🟢 Presence set to *online*.");
  }
});

register("offline", {
  category: "presence",
  description: "Set the account presence to offline.",
  ownerOnly: true,
  async run(ctx) {
    await settings.update({ presence: "unavailable" });
    await ctx.socket.sendPresenceUpdate("unavailable");
    await ctx.reply("⚫ Presence set to *offline*.");
  }
});

// ---------------------------------------------------------------- status

register("statusview", {
  category: "status",
  usage: "on|off",
  description: "Automatically view contacts' statuses.",
  ownerOnly: true,
  async run(ctx) {
    const value = (ctx.args[0] || "").toLowerCase();

    if (value !== "on" && value !== "off") {
      return ctx.reply(`Usage: ${config.PREFIX}statusview on|off`);
    }

    await settings.update({ statusView: value === "on" });
    await ctx.reply(`Auto status view is now *${value}*.`);
  }
});

register("statusreact", {
  category: "status",
  usage: "on|off",
  description: "Automatically react to contacts' statuses.",
  ownerOnly: true,
  async run(ctx) {
    const value = (ctx.args[0] || "").toLowerCase();

    if (value !== "on" && value !== "off") {
      return ctx.reply(`Usage: ${config.PREFIX}statusreact on|off`);
    }

    await settings.update({ statusReact: value === "on" });
    await ctx.reply(`Auto status reaction is now *${value}*.`);
  }
});

register("setreact", {
  category: "status",
  usage: "❤️|🔥|😂|🥹|💙",
  description: "Choose the emoji used for status reactions.",
  ownerOnly: true,
  async run(ctx) {
    const emoji = ctx.args[0];

    if (!emoji || !config.REACTION_EMOJIS.includes(emoji)) {
      return ctx.reply(
        `Usage: ${config.PREFIX}setreact ${config.REACTION_EMOJIS.join(" ")}`
      );
    }

    await settings.update({ reactionEmoji: emoji });
    await ctx.reply(`Status reaction emoji set to ${emoji}`);
  }
});

register("statusinfo", {
  category: "status",
  description: "Show status automation settings and counters.",
  ownerOnly: false,
  async run(ctx) {
    const current = settings.get();
    const counts = ctx.stats || { viewed: 0, reacted: 0 };

    await ctx.reply(
      `📡 *STATUS AUTOMATION*\n` +
        `Auto view: ${current.statusView ? "on" : "off"}\n` +
        `Auto react: ${current.statusReact ? "on" : "off"}\n` +
        `Emoji: ${current.reactionEmoji}\n` +
        `Viewed this run: ${counts.viewed}\n` +
        `Reacted this run: ${counts.reacted}`
    );
  }
});

// ---------------------------------------------------------------- media

register("getdp", {
  category: "media",
  description: "Fetch the profile picture of a quoted or mentioned contact.",
  ownerOnly: false,
  async run(ctx) {
    const jid = targetJid(ctx);

    if (!jid) return ctx.reply("Reply to a message or mention a contact.");

    let url;

    try {
      url = await ctx.socket.profilePictureUrl(jid, "image");
    } catch {
      url = null;
    }

    if (!url) {
      return ctx.reply(
        "No profile picture available — the contact may hide it with privacy settings."
      );
    }

    await ctx.socket.sendMessage(
      ctx.jid,
      { image: { url }, caption: "❄️ Profile picture" },
      { quoted: ctx.msg }
    );
  }
});

register("save", {
  category: "media",
  description: "Save the media in the message you replied to.",
  ownerOnly: false,
  async run(ctx) {
    const info = contextInfo(ctx.msg.message);

    if (!info?.quotedMessage) {
      return ctx.reply("Reply to an image, video, audio or document with .save");
    }

    if (isViewOnce(info.quotedMessage)) {
      return ctx.reply(
        "That media was sent as view-once. NORA MD respects WhatsApp privacy protections and cannot save it."
      );
    }

    const quoted = info.quotedMessage;
    const key = {
      remoteJid: ctx.jid,
      id: info.stanzaId,
      participant: info.participant,
      fromMe: false
    };

    const type = quoted.imageMessage
      ? "image"
      : quoted.videoMessage
      ? "video"
      : quoted.audioMessage
      ? "audio"
      : quoted.documentMessage
      ? "document"
      : null;

    if (!type) return ctx.reply("No savable media found in that message.");

    let buffer;

    try {
      buffer = await downloadMediaMessage(
        { key, message: quoted },
        "buffer",
        {},
        { logger: SILENT_LOGGER, reuploadRequest: ctx.socket.updateMediaMessage }
      );
    } catch {
      return ctx.reply(
        "Could not download that media — it may have expired or be unavailable."
      );
    }

    if (!buffer) return ctx.reply("Could not download that media.");

    const source = quoted[`${type}Message`];
    const content = { caption: "❄️ Saved by NORA MD" };

    if (type === "audio") {
      content.audio = buffer;
      content.mimetype = source?.mimetype || "audio/mp4";
    } else if (type === "document") {
      content.document = buffer;
      content.mimetype = source?.mimetype || "application/octet-stream";
      content.fileName = source?.fileName || "nora-md-file";
    } else {
      content[type] = buffer;
    }

    await ctx.socket.sendMessage(ctx.jid, content, { quoted: ctx.msg });
  }
});

register("vv", {
  category: "media",
  description: "Explain how view-once media is handled.",
  ownerOnly: false,
  async run(ctx) {
    await ctx.reply(
      "🔒 View-once media is protected by WhatsApp. NORA MD does not bypass that privacy protection, so .vv cannot reveal or resend it.\n" +
        "Use .save on a normal image, video, audio or document instead."
    );
  }
});

// ---------------------------------------------------------------- owner

register("restart", {
  category: "owner",
  description: "Reconnect the WhatsApp socket without deleting the session.",
  ownerOnly: true,
  async run(ctx) {
    await ctx.reply("♻️ Reconnecting NORA MD…");
    setTimeout(() => {
      ctx.botApi.restart().catch(() => {});
    }, 500);
  }
});

register("settings", {
  category: "owner",
  description: "Show the current bot settings.",
  ownerOnly: true,
  async run(ctx) {
    const current = settings.get();

    await ctx.reply(
      `⚙️ *SETTINGS*\n` +
        `Prefix: ${config.PREFIX}\n` +
        `Presence: ${current.presence}\n` +
        `Auto view status: ${current.statusView ? "on" : "off"}\n` +
        `Auto react status: ${current.statusReact ? "on" : "off"}\n` +
        `Reaction emoji: ${current.reactionEmoji}`
    );
  }
});

register("blocklist", {
  category: "owner",
  description: "List blocked contacts.",
  ownerOnly: true,
  async run(ctx) {
    let blocked = [];

    try {
      blocked = (await ctx.socket.fetchBlocklist()).filter(Boolean);
    } catch {
      return ctx.reply("Could not read the blocklist right now.");
    }

    if (!blocked.length) return ctx.reply("Blocklist is empty.");

    const lines = blocked.map((jid) => `• ${jid.split("@")[0]}`).join("\n");
    await ctx.reply(`🚫 *BLOCKED (${blocked.length})*\n${lines}`);
  }
});

register("unblock", {
  category: "owner",
  usage: "<number>",
  description: "Unblock a contact.",
  ownerOnly: true,
  async run(ctx) {
    const jid = normalizeJid(ctx.args[0]) || targetJid(ctx);

    if (!jid) return ctx.reply(`Usage: ${config.PREFIX}unblock 947XXXXXXXX`);

    try {
      await ctx.socket.updateBlockStatus(jid, "unblock");
    } catch {
      return ctx.reply("Could not unblock that contact.");
    }

    await ctx.reply(`✅ Unblocked ${jid.split("@")[0]}.`);
  }
});

// ---------------------------------------------------------------- dispatch

async function handle({ socket, msg, text, isOwner, stats, botApi }) {
  const body = text.slice(config.PREFIX.length).trim();
  if (!body) return;

  const [rawName, ...args] = body.split(/\s+/);
  const name = rawName.toLowerCase();
  const definition = registry.get(name);

  if (!definition) {
    await socket.sendMessage(
      msg.key.remoteJid,
      { text: `Unknown command. Send ${config.PREFIX}menu to see everything.` },
      { quoted: msg }
    );
    return;
  }

  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;

  const ctx = {
    socket,
    msg,
    text,
    args,
    jid,
    sender,
    isOwner,
    stats,
    botApi,
    reply: (replyText) =>
      socket.sendMessage(jid, { text: replyText }, { quoted: msg })
  };

  if (definition.ownerOnly && !isOwner) {
    await ctx.reply("🔒 This command is restricted to the bot owner.");
    return;
  }

  await definition.run(ctx);
}

function docs() {
  return CATEGORY_ORDER.map((category) => ({
    category,
    commands: [...registry.entries()]
      .filter(([, def]) => def.category === category)
      .map(([name, def]) => ({
        name,
        usage: def.usage || "",
        description: def.description,
        ownerOnly: Boolean(def.ownerOnly)
      }))
  })).filter((group) => group.commands.length > 0);
}

module.exports = {
  handle,
  docs,
  registry
};
