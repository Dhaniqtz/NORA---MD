
require("dotenv").config();

const express = require("express");
const pino = require("pino");
const path = require("path");
const fs = require("fs");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require("@whiskeysockets/baileys");

const config = require("./config");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let sock;
let connectionStatus = "offline";
let pairingCode = null;
let connecting = false;
let requestedNumber = null;

const logger = pino({ level: "silent" });

async function startBot() {
  if (connecting) return;
  connecting = true;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState("./session");

    sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu("NORA MD"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "connecting") {
        connectionStatus = "connecting";
      }

      if (connection === "open") {
        connectionStatus = "online";
        pairingCode = null;
        requestedNumber = null;

        await sock.sendPresenceUpdate("unavailable");
        console.log("NORA MD connected!");
      }

      if (connection === "close") {
        connectionStatus = "offline";
        connecting = false;

        const code = lastDisconnect?.error?.output?.statusCode;

        if (code !== DisconnectReason.loggedOut) {
          setTimeout(startBot, 5000);
        } else {
          console.log("WhatsApp logged out. Re-pair required.");
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
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
          await sock.sendMessage(jid, {
            text: "Pong! ❄️ NORA MD is online."
          });
        }

        if (command === "alive") {
          await sock.sendMessage(jid, {
            text: "NORA MD is running! 🤍"
          });
        }

        if (command === "menu") {
          await sock.sendMessage(jid, {
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
          await sock.sendPresenceUpdate("available");
          await sock.sendMessage(jid, {
            text: "NORA MD presence set to online."
          });
        }

        if (command === "offline") {
          await sock.sendPresenceUpdate("unavailable");
          await sock.sendMessage(jid, {
            text: "NORA MD presence set to offline."
          });
        }
      }
    });

  } catch (error) {
    console.error("Bot error:", error.message);
    connecting = false;
    connectionStatus = "offline";
  }
}

// Generate pairing code
app.post("/api/pair", async (req, res) => {
  try {
    const number = String(req.body.number || "")
      .replace(/\D/g, "");

    if (number.length < 10 || number.length > 15) {
      return res.status(400).json({
        error: "Enter a valid international phone number."
      });
    }

    if (connectionStatus === "online") {
      return res.status(409).json({
        error: "NORA MD is already connected."
      });
    }

    if (sock?.authState?.creds?.registered) {
      return res.status(409).json({
        error: "A WhatsApp session already exists."
      });
    }

    if (!sock) {
      requestedNumber = number;
      await startBot();
    } else if (requestedNumber && requestedNumber !== number) {
      return res.status(409).json({
        error: "Pairing is already in progress."
      });
    }

    requestedNumber = number;

    // Wait for socket initialization
    let attempts = 0;

    while (!sock?.requestPairingCode && attempts < 20) {
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
    }

    if (!sock?.requestPairingCode) {
      return res.status(503).json({
        error: "WhatsApp connection is not ready. Try again."
      });
    }

    const code = await sock.requestPairingCode(number);
    pairingCode = code;

    res.json({
      success: true,
      code
    });

  } catch (error) {
    console.error("Pairing error:", error.message);

    res.status(500).json({
      error: "Could not generate pairing code."
    });
  }
});

// Connection status
app.get("/api/status", (req, res) => {
  res.json({
    bot: config.BOT_NAME,
    status: connectionStatus,
    pairing: Boolean(pairingCode)
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(config.PORT, () => {
  console.log(`NORA MD server running on port ${config.PORT}`);
});
