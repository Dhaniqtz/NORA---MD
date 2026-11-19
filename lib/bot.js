"use strict";

const fs = require("fs");
const path = require("path");
const pino = require("pino");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require("@whiskeysockets/baileys");

const config = require("../config");
const logger = require("./logger");

const MAX_RECONNECT_ATTEMPTS = 10;
const SILENT_LOGGER = pino({ level: "silent" });

let sock = null;
let startPromise = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let stopped = false;

let connectionStatus = "offline";
let pairingCode = null;
let pairingNumber = null;
let pairingInFlight = false;
let lastPairRequestAt = 0;

function makeError(internalMessage, status, publicMessage) {
  const error = new Error(internalMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  return error;
}

function hasSession() {
  return fs.existsSync(path.join(config.SESSION_DIR, "creds.json"));
}

function isRegistered() {
  return Boolean(sock?.authState?.creds?.registered) || hasSession();
}

function getStatus() {
  return {
    status: connectionStatus,
    pairing: Boolean(pairingCode),
    registered: isRegistered(),
    reconnectAttempt: reconnectAttempts
  };
}

function pairCooldownRemaining() {
  const remaining = config.PAIR_COOLDOWN_MS - (Date.now() - lastPairRequestAt);
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    connectionStatus = "offline";
    logger.error({ event: "bot.reconnect_exhausted", attempts: reconnectAttempts });
    return;
  }

  reconnectAttempts += 1;

  const delay = Math.min(
    config.RECONNECT_BASE_DELAY * 2 ** (reconnectAttempts - 1),
    config.RECONNECT_MAX_DELAY
  );

  connectionStatus = "reconnecting";
  logger.warn({
    event: "bot.reconnect_scheduled",
    attempt: reconnectAttempts,
    delayMs: delay
  });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch(() => {
      if (!stopped) scheduleReconnect();
    });
  }, delay);
}

function startBot({ resetAttempts = false } = {}) {
  if (stopped) {
    return Promise.reject(makeError("Bot is shutting down.", 503, "Bot is shutting down."));
  }

  if (startPromise) return startPromise;
  if (sock) return Promise.resolve(sock);

  if (resetAttempts) {
    reconnectAttempts = 0;
    clearReconnectTimer();
  }

  if (connectionStatus !== "reconnecting") connectionStatus = "connecting";

  startPromise = (async () => {
    logger.info({ event: "bot.starting" });

    const { state, saveCreds } = await useMultiFileAuthState(config.SESSION_DIR);

    const socket = makeWASocket({
      auth: state,
      logger: SILENT_LOGGER,
      browser: Browsers.ubuntu("NORA MD"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock = socket;

    socket.ev.on("creds.update", () => {
      saveCreds().catch((error) => {
        logger.error({ event: "session.save_failed", message: error.message });
      });
    });

    socket.ev.on("connection.update", (update) => {
      handleConnectionUpdate(socket, update).catch((error) => {
        logger.error({ event: "bot.update_failed", message: error.message });
      });
    });

    socket.ev.on("messages.upsert", (payload) => {
      handleMessages(socket, payload).catch((error) => {
        logger.error({ event: "bot.message_failed", message: error.message });
      });
    });

    return socket;
  })()
    .catch((error) => {
      if (sock) {
        try {
          sock.end(undefined);
        } catch {
          // socket already closed
        }
      }

      sock = null;
      connectionStatus = "offline";
      logger.error({ event: "bot.start_failed", message: error.message });
      throw error;
    })
    .finally(() => {
      startPromise = null;
    });

  return startPromise;
}

async function handleConnectionUpdate(socket, update) {
  // Ignore updates from a socket that has already been replaced.
  if (socket !== sock) return;

  const { connection, lastDisconnect } = update;

  if (connection === "connecting") {
    if (connectionStatus !== "reconnecting") connectionStatus = "connecting";
    return;
  }

  if (connection === "open") {
    connectionStatus = "online";
    reconnectAttempts = 0;
    clearReconnectTimer();
    pairingCode = null;
    pairingNumber = null;
    pairingInFlight = false;

    try {
      await socket.sendPresenceUpdate(config.DEFAULT_PRESENCE || "unavailable");
    } catch (error) {
      logger.warn({ event: "presence.failed", message: error.message });
    }

    logger.info({ event: "bot.connected" });
    return;
  }

  if (connection === "close") {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    const wasPairing = Boolean(pairingNumber || pairingInFlight);

    sock = null;
    pairingCode = null;
    pairingNumber = null;
    pairingInFlight = false;

    if (loggedOut) {
      connectionStatus = "offline";
      await clearSession();
      logger.warn({ event: "bot.logged_out" });
      return;
    }

    if (stopped) return;

    logger.warn({ event: "bot.closed", statusCode: statusCode ?? null });

    // Nothing to reconnect to when there is no saved session and no pairing
    // attempt in progress.
    if (!hasSession() && !wasPairing) {
      connectionStatus = "offline";
      return;
    }

    scheduleReconnect();
  }
}

async function handleMessages(socket, { messages }) {
  for (const msg of messages) {
    if (!msg.message || msg.key.fromMe) continue;

    const jid = msg.key.remoteJid;
    if (!jid || jid === "status@broadcast") continue;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (!text.startsWith(config.PREFIX)) continue;

    const [command] = text
      .slice(config.PREFIX.length)
      .trim()
      .split(/\s+/);

    if (command === "ping") {
      await socket.sendMessage(jid, {
        text: "Pong! ❄️ NORA MD is online."
      });
    }

    if (command === "alive") {
      await socket.sendMessage(jid, {
        text: "NORA MD is running! 🤍"
      });
    }

    if (command === "menu") {
      await socket.sendMessage(jid, {
        text: `❄️ NORA MD MENU

.status
.statusview on/off
.statusreact on/off
.setreact ❤️,🔥,😂
.statusinfo

.getdp
.save
.vv

.online
.offline

.ping
.alive
.runtime`
      });
    }

    if (command === "online") {
      await socket.sendPresenceUpdate("available");
      await socket.sendMessage(jid, {
        text: "NORA MD presence set to online."
      });
    }

    if (command === "offline") {
      await socket.sendPresenceUpdate("unavailable");
      await socket.sendMessage(jid, {
        text: "NORA MD presence set to offline."
      });
    }
  }
}

function waitForPairingSupport(socket, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    const tick = () => {
      if (socket !== sock) return resolve(false);
      if (typeof socket.requestPairingCode === "function") return resolve(true);
      if (Date.now() - startedAt >= timeoutMs) return resolve(false);
      setTimeout(tick, 250);
    };

    tick();
  });
}

async function requestPairingCode(number) {
  if (connectionStatus === "online") {
    throw makeError(
      "Pairing requested while online.",
      409,
      "NORA MD is already connected to WhatsApp."
    );
  }

  if (isRegistered()) {
    throw makeError(
      "Pairing requested with an existing session.",
      409,
      "A WhatsApp session already exists on this server."
    );
  }

  if (pairingInFlight) {
    throw makeError(
      "Duplicate pairing request.",
      409,
      "Pairing is already in progress. Wait a moment."
    );
  }

  if (pairingCode && pairingNumber === number) {
    throw makeError(
      "Pairing code already issued.",
      409,
      "A pairing code was already generated. Wait for it to expire before requesting another."
    );
  }

  pairingInFlight = true;
  pairingNumber = number;
  lastPairRequestAt = Date.now();

  try {
    await startBot({ resetAttempts: true });

    const socket = sock;

    if (!socket) {
      throw makeError(
        "Socket unavailable.",
        503,
        "WhatsApp connection is not ready. Try again."
      );
    }

    if (socket.authState?.creds?.registered) {
      throw makeError(
        "Session registered before pairing.",
        409,
        "A WhatsApp session already exists on this server."
      );
    }

    const ready = await waitForPairingSupport(socket, 10000);

    if (!ready) {
      throw makeError(
        "Pairing support not ready.",
        503,
        "WhatsApp connection is not ready. Try again in a few seconds."
      );
    }

    const code = await socket.requestPairingCode(number);

    if (!code) {
      throw makeError(
        "WhatsApp returned no pairing code.",
        502,
        "WhatsApp did not return a pairing code. Try again."
      );
    }

    pairingCode = code;
    logger.info({ event: "pairing.code_issued" });

    return code;
  } catch (error) {
    if (error.status) throw error;

    logger.error({ event: "pairing.failed", message: error.message });

    throw makeError(
      "Could not generate pairing code.",
      502,
      "Could not reach WhatsApp. Try again."
    );
  } finally {
    pairingInFlight = false;
  }
}

async function clearSession() {
  try {
    await fs.promises.rm(config.SESSION_DIR, { recursive: true, force: true });
  } catch (error) {
    logger.error({ event: "session.clear_failed", message: error.message });
  }
}

async function stop() {
  stopped = true;
  clearReconnectTimer();

  const socket = sock;
  sock = null;
  connectionStatus = "offline";

  if (socket) {
    try {
      await socket.end(undefined);
    } catch {
      // socket already closed
    }
  }
}

module.exports = {
  startBot,
  stop,
  getStatus,
  requestPairingCode,
  pairCooldownRemaining,
  hasSession,
  isRegistered
};
