"use strict";

const pino = require("pino");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require("@whiskeysockets/baileys");

const config = require("../config");
const logger = require("./logger");
const session = require("./session");
const settings = require("./settings");
const commands = require("./commands");

const MAX_RECONNECT_ATTEMPTS = 10;
const SILENT_LOGGER = pino({ level: "silent" });
const STATUS_SEEN_LIMIT = 500;

let sock = null;
let startPromise = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let stopped = false;

let connectionStatus = "offline";
let connectedAt = null;
let lastError = null;

let pairing = null; // { code, number, issuedAt, expiresAt }
let pairingInFlight = false;
let pairingTimer = null;
let lastPairRequestAt = 0;

const startedAt = Date.now();
const handshakeReady = new WeakSet();
const statusSeen = new Map();
const stats = { viewed: 0, reacted: 0 };

function makeError(internalMessage, status, publicMessage, code, retryAfter) {
  const error = new Error(internalMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  error.code = code;
  if (retryAfter !== undefined) error.retryAfter = retryAfter;
  return error;
}

function maskNumber(raw) {
  const digits = String(raw || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");

  if (digits.length < 7) return null;
  return `${digits.slice(0, 3)}${"•".repeat(digits.length - 7)}${digits.slice(-4)}`;
}

function uptimeSeconds() {
  return Math.floor((Date.now() - startedAt) / 1000);
}

function ownJid() {
  return sock?.user?.id || sock?.authState?.creds?.me?.id || null;
}

function pairingActive() {
  return Boolean(pairing && pairing.expiresAt > Date.now());
}

function clearPairingTimer() {
  if (pairingTimer) {
    clearTimeout(pairingTimer);
    pairingTimer = null;
  }
}

function clearPairing() {
  clearPairingTimer();
  pairing = null;
}

function armPairingExpiry() {
  clearPairingTimer();

  if (!pairing) return;

  const delay = Math.max(0, pairing.expiresAt - Date.now());

  pairingTimer = setTimeout(() => {
    pairingTimer = null;

    if (!pairing || pairing.expiresAt > Date.now()) return;

    pairing = null;
    lastError = {
      code: "pairing_expired",
      message:
        "The pairing code expired before the device was linked. Request a new code.",
      at: new Date().toISOString()
    };
    logger.warn({ event: "pairing.expired" });
  }, delay);

  if (typeof pairingTimer.unref === "function") pairingTimer.unref();
}

function pairCooldownRemaining() {
  const remaining = config.PAIR_COOLDOWN_MS - (Date.now() - lastPairRequestAt);
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

function getStatus() {
  const stored = session.read();

  return {
    status: connectionStatus,
    registered: stored.registered,
    sessionState: stored.state,
    pairingActive: pairingActive(),
    reconnectAttempt: reconnectAttempts,
    uptimeSeconds: uptimeSeconds()
  };
}

function getSessionInfo() {
  const stored = session.read();
  const now = Date.now();
  const active = pairingActive();

  return {
    status: connectionStatus,
    session: {
      state: stored.state,
      registered: stored.registered,
      number: maskNumber(stored.me?.id),
      name: stored.me?.name && stored.me.name !== "~" ? stored.me.name : null,
      updatedAt: stored.updatedAt,
      detail: stored.detail || null
    },
    pairing: pairing
      ? {
          active,
          code: active ? pairing.code : null,
          number: maskNumber(pairing.number),
          expiresAt: pairing.expiresAt,
          secondsLeft: active
            ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000))
            : 0
        }
      : null,
    reconnectAttempt: reconnectAttempts,
    uptimeSeconds: uptimeSeconds(),
    connectedAt,
    socketOpen: Boolean(sock?.ws?.isOpen),
    lastError,
    stats: { ...stats }
  };
}

// --------------------------------------------------------------- connection

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
    lastError = {
      code: "reconnect_exhausted",
      message: "Could not reconnect to WhatsApp. Reconnect manually from the dashboard.",
      at: new Date().toISOString()
    };
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

// `ws.isOpen` only means the TCP socket is up: requesting a pairing code then
// sends an unencrypted frame and WhatsApp drops the connection (status 428).
// The first `qr` update is emitted after the noise handshake completes, which
// is the earliest point a pairing code can be requested safely.
function waitForPairingReady(socket, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();

    const tick = () => {
      if (socket !== sock) return resolve(false);
      if (handshakeReady.has(socket) || connectionStatus === "online") {
        return resolve(true);
      }
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(tick, 150);
    };

    tick();
  });
}

function startBot() {
  if (stopped) {
    return Promise.reject(
      makeError("Bot is shutting down.", 503, "Bot is shutting down.", "stopped")
    );
  }

  if (sock) return Promise.resolve(sock);
  if (startPromise) return startPromise;

  if (connectionStatus !== "reconnecting") connectionStatus = "connecting";

  startPromise = (async () => {
    logger.info({ event: "bot.starting" });

    const { state, saveCreds } = await useMultiFileAuthState(config.SESSION_DIR);

    // An unfinished pairing attempt leaves `me` (and a dead pairingCode) in
    // creds.json. Baileys then takes its "login as an existing device" path,
    // WhatsApp drops the socket and no pairing code can ever complete. Clearing
    // only that marker restores the registration path; the keys stay untouched.
    if (
      state.creds &&
      state.creds.registered !== true &&
      (state.creds.me || state.creds.pairingCode)
    ) {
      delete state.creds.me;
      delete state.creds.pairingCode;
      await saveCreds();
      logger.info({ event: "session.pairing_state_cleaned" });
    }

    const socket = makeWASocket({
      auth: state,
      logger: SILENT_LOGGER,
      // WhatsApp validates the browser name for pairing-code links; the app
      // name belongs in the dashboard, not in the device descriptor.
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Baileys ends the socket when its QR refs run out (60s by default), which
      // would kill the connection while the user is still typing the pairing
      // code. Keep it alive for the whole code lifetime.
      qrTimeout: config.PAIR_CODE_TTL_MS + 30000
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
      handleUpsert(socket, payload).catch((error) => {
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
      lastError = {
        code: "start_failed",
        message: "Could not start the WhatsApp connection.",
        at: new Date().toISOString()
      };
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

  // Emitted once the noise handshake is complete (QR/pair-device stage).
  if (update.qr) {
    handshakeReady.add(socket);
    return;
  }

  if (connection === "connecting") {
    if (connectionStatus !== "reconnecting") connectionStatus = "connecting";
    return;
  }

  if (connection === "open") {
    handshakeReady.add(socket);
    connectionStatus = "online";
    connectedAt = Date.now();
    reconnectAttempts = 0;
    clearReconnectTimer();
    clearPairing();
    session.clearInvalid();
    lastError = null;

    try {
      await socket.sendPresenceUpdate(settings.get().presence);
    } catch (error) {
      logger.warn({ event: "presence.failed", message: error.message });
    }

    logger.info({ event: "bot.connected" });
    return;
  }

  if (connection === "close") {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const wasPairing = pairingInFlight || Boolean(pairing);

    sock = null;
    connectedAt = null;

    const codeWasIssued = Boolean(pairing);

    if (pairingInFlight || codeWasIssued) {
      lastError = {
        code: "pairing_closed",
        message:
          "WhatsApp closed the link request. Check the number (with country code) and that the account can add a linked device, then request a new code.",
        at: new Date().toISOString()
      };
    }

    clearPairing();

    if (statusCode === DisconnectReason.loggedOut) {
      connectionStatus = "offline";
      session.markInvalid("logged_out");
      lastError = {
        code: "logged_out",
        message:
          "WhatsApp removed this linked device. Reset the session, then pair again.",
        at: new Date().toISOString()
      };
      logger.warn({ event: "bot.logged_out" });
      return;
    }

    if (stopped) return;

    logger.warn({ event: "bot.closed", statusCode: statusCode ?? null });

    const stored = session.read();

    // Nothing to reconnect to when the session was never registered and no
    // pairing attempt is running: stay offline instead of looping.
    if (!stored.registered) {
      connectionStatus = "offline";

      if (wasPairing && !lastError) {
        lastError = {
          code: "pairing_closed",
          message: "The WhatsApp link closed before pairing finished. Try again.",
          at: new Date().toISOString()
        };
      }

      return;
    }

    if (!lastError) {
      lastError = {
        code: "connection_closed",
        message: "Connection lost. Reconnecting…",
        at: new Date().toISOString()
      };
    }

    scheduleReconnect();
  }
}

async function closeSocket() {
  const current = sock;
  sock = null;

  if (!current) return;

  try {
    await current.end(undefined);
  } catch {
    // socket already closed
  }

  // Give the transport a moment to release the socket before a new one opens.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function restart() {
  clearReconnectTimer();
  reconnectAttempts = 0;
  await closeSocket();
  connectionStatus = "offline";
  return startBot();
}

async function reconnect() {
  const stored = session.read();

  if (!stored.registered) {
    throw makeError(
      "No registered session to reconnect.",
      409,
      "No linked WhatsApp session on this server. Pair first.",
      "not_registered"
    );
  }

  clearReconnectTimer();
  reconnectAttempts = 0;
  clearPairing();
  await closeSocket();
  connectionStatus = "connecting";

  return startBot();
}

async function applyPresence() {
  if (!sock || connectionStatus !== "online") return;

  await sock.sendPresenceUpdate(settings.get().presence);
}

function autoStart() {
  const stored = session.read();

  if (stored.state !== "registered") {
    logger.info({ event: "bot.awaiting_pairing", sessionState: stored.state });
    return Promise.resolve(null);
  }

  return startBot().catch((error) => {
    logger.error({ event: "bot.auto_start_failed", message: error.message });
    return null;
  });
}

// ----------------------------------------------------------------- pairing

async function ensureFreshSocket() {
  if (sock) await closeSocket();

  connectionStatus = "connecting";

  return startBot();
}

async function requestPairingCode(number) {
  if (stopped) {
    throw makeError("Bot is shutting down.", 503, "Bot is shutting down.", "stopped");
  }

  if (connectionStatus === "online") {
    throw makeError(
      "Pairing requested while online.",
      409,
      "NORA MD is already connected to WhatsApp.",
      "already_connected"
    );
  }

  const stored = session.read();

  if (stored.state === "registered" || stored.state === "logged_out") {
    // Requirement: a registered session is reconnected, never re-paired.
    if (stored.state === "registered") {
      startBot().catch(() => {});
    }

    throw makeError(
      "Pairing requested with a registered session.",
      409,
      stored.state === "logged_out"
        ? "WhatsApp removed this linked device. Reset the session, then pair again."
        : "This server already has a linked WhatsApp session. Reconnecting it now.",
      stored.state === "logged_out" ? "session_logged_out" : "already_registered"
    );
  }

  if (stored.state === "corrupted") {
    throw makeError(
      "Pairing blocked by a corrupted session.",
      409,
      "The saved WhatsApp session is unreadable. Reset the session, then pair again.",
      "session_corrupted"
    );
  }

  if (pairingInFlight) {
    throw makeError(
      "Duplicate pairing request.",
      409,
      "Pairing is already in progress. Wait a moment.",
      "pairing_in_progress"
    );
  }

  if (pairingActive()) {
    if (pairing.number === number) {
      return {
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        reused: true
      };
    }

    const wait = Math.ceil((pairing.expiresAt - Date.now()) / 1000);

    throw makeError(
      "Pairing code active for another number.",
      429,
      `A pairing code is already active for another number. Try again in ${wait}s.`,
      "pairing_conflict",
      wait
    );
  }

  const cooldown = pairCooldownRemaining();

  if (cooldown > 0) {
    throw makeError(
      "Pairing cooldown active.",
      429,
      `Please wait ${cooldown}s before requesting another pairing code.`,
      "cooldown",
      cooldown
    );
  }

  pairingInFlight = true;
  lastPairRequestAt = Date.now();
  lastError = null;

  try {
    // Always start from a fresh socket: a stale socket keeps the previous
    // (expired) link-code registration session alive on WhatsApp's side.
    await ensureFreshSocket();

    const socket = sock;

    if (!socket) {
      throw makeError(
        "Socket unavailable.",
        503,
        "WhatsApp connection is not ready. Try again.",
        "socket_unavailable"
      );
    }

    if (socket.authState?.creds?.registered) {
      throw makeError(
        "Session registered before pairing.",
        409,
        "This server already has a linked WhatsApp session.",
        "already_registered"
      );
    }

    const ready = await waitForPairingReady(socket, config.PAIR_SOCKET_TIMEOUT_MS);

    if (!ready) {
      throw makeError(
        "Socket handshake did not complete in time.",
        503,
        "Could not reach WhatsApp in time. Try again in a few seconds.",
        "socket_timeout"
      );
    }

    const code = await socket.requestPairingCode(number);

    if (!code || typeof code !== "string") {
      throw makeError(
        "WhatsApp returned no pairing code.",
        502,
        "WhatsApp did not return a pairing code. Try again.",
        "no_code"
      );
    }

    pairing = {
      code,
      number,
      issuedAt: Date.now(),
      expiresAt: Date.now() + config.PAIR_CODE_TTL_MS
    };
    armPairingExpiry();

    logger.info({ event: "pairing.code_issued" });

    return { code, expiresAt: pairing.expiresAt, reused: false };
  } catch (error) {
    if (error.status) {
      if (error.status >= 500) {
        lastError = {
          code: error.code || "pairing_failed",
          message: error.publicMessage,
          at: new Date().toISOString()
        };
      }
      throw error;
    }

    logger.error({ event: "pairing.failed", message: error.message });
    lastError = {
      code: "pairing_failed",
      message: "Could not reach WhatsApp. Try again.",
      at: new Date().toISOString()
    };

    throw makeError(
      "Could not generate pairing code.",
      502,
      "Could not reach WhatsApp. Try again.",
      "pairing_failed"
    );
  } finally {
    pairingInFlight = false;
  }
}

async function resetSession() {
  if (connectionStatus === "online") {
    throw makeError(
      "Session reset requested while online.",
      409,
      "NORA MD is connected. Disconnect it before resetting the session.",
      "session_active"
    );
  }

  await closeSocket();
  clearReconnectTimer();
  clearPairing();
  reconnectAttempts = 0;
  connectionStatus = "offline";
  connectedAt = null;
  lastError = null;

  const backup = await session.backupAndClear();

  logger.warn({ event: "session.reset", backupKept: Boolean(backup) });

  return backup;
}

// ------------------------------------------------------------ status + chat

function getMessageText(message) {
  if (!message) return "";

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  );
}

function markStatusSeen(id) {
  if (!id) return false;
  if (statusSeen.has(id)) return true;

  statusSeen.set(id, Date.now());

  if (statusSeen.size > STATUS_SEEN_LIMIT) {
    const oldest = statusSeen.keys().next().value;
    statusSeen.delete(oldest);
  }

  return false;
}

async function handleStatus(socket, msg) {
  const participant = msg.key.participant;
  const own = ownJid();

  if (!participant) return;
  if (own && participant.split("@")[0] === own.split("@")[0]) return;

  if (markStatusSeen(msg.key.id)) return;

  const current = settings.get();

  if (current.statusView) {
    try {
      await socket.readMessages([msg.key]);
      stats.viewed += 1;
    } catch (error) {
      logger.warn({ event: "status.view_failed", message: error.message });
    }
  }

  if (current.statusReact) {
    try {
      const statusJidList = [participant];
      if (own) statusJidList.push(own);

      await socket.sendMessage(
        "status@broadcast",
        { react: { text: current.reactionEmoji, key: msg.key } },
        { statusJidList }
      );
      stats.reacted += 1;
    } catch (error) {
      logger.warn({ event: "status.react_failed", message: error.message });
    }
  }
}

function isOwnerMessage(socket, msg) {
  if (msg.key.fromMe) return true;

  const sender = (msg.key.participant || msg.key.remoteJid || "").split("@")[0];
  if (!sender) return false;

  if (config.OWNER_NUMBER && sender === config.OWNER_NUMBER) return true;

  const own = ownJid();
  if (own && sender === own.split("@")[0]) return true;

  return false;
}

async function handleUpsert(socket, { messages }) {
  for (const msg of messages) {
    try {
      if (!msg.message) continue;

      if (msg.key.remoteJid === "status@broadcast") {
        await handleStatus(socket, msg);
        continue;
      }

      const jid = msg.key.remoteJid;
      if (!jid || jid === "broadcast") continue;

      const text = getMessageText(msg.message);
      if (!text || !text.trimStart().startsWith(config.PREFIX)) continue;

      await commands.handle({
        socket,
        msg,
        text: text.trimStart(),
        isOwner: isOwnerMessage(socket, msg),
        stats,
        botApi: api
      });
    } catch (error) {
      logger.warn({ event: "command.failed", message: error.message });
    }
  }
}

// ----------------------------------------------------------------- shutdown

async function stop() {
  stopped = true;
  clearReconnectTimer();
  clearPairing();
  await closeSocket();
  connectionStatus = "offline";
  connectedAt = null;
}

const api = {
  startBot,
  restart,
  reconnect,
  stop,
  autoStart,
  applyPresence,
  getStatus,
  getSessionInfo,
  requestPairingCode,
  pairCooldownRemaining,
  resetSession
};

module.exports = api;
