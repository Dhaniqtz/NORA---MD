"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");

const config = require("./config");
const logger = require("./lib/logger");
const bot = require("./lib/bot");
const security = require("./lib/security");
const settings = require("./lib/settings");
const commands = require("./lib/commands");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

app.use(express.json({ limit: "10kb" }));
app.use(security.cors);
app.use(express.static(path.join(__dirname, "public")));

const pairLimiter = security.createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 6,
  name: "pair"
});

const loginLimiter = security.createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  name: "login"
});

const actionLimiter = security.createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 20,
  name: "action"
});

function cookieOptions(req) {
  const crossSite = config.ALLOWED_ORIGINS.length > 0;

  return {
    httpOnly: true,
    sameSite: crossSite ? "none" : "lax",
    secure: crossSite ? true : req.secure,
    path: "/",
    maxAge: security.SESSION_TTL_MS
  };
}

function sendBotError(res, error, fallback) {
  const status = error.status || 500;

  if (status >= 500) {
    logger.error({ event: "bot.request_failed", message: error.message });
  }

  const body = {
    error: error.publicMessage || fallback
  };

  if (error.code) body.code = error.code;
  if (error.retryAfter !== undefined) {
    body.retryAfter = error.retryAfter;
    res.setHeader("Retry-After", String(error.retryAfter));
  }

  return res.status(status).json(body);
}

// ------------------------------------------------------------------- auth

app.post("/api/auth/login", loginLimiter, (req, res) => {
  if (!config.DASHBOARD_PASSWORD) {
    return res.status(400).json({
      error: "Dashboard authentication is not enabled."
    });
  }

  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!password || !security.safeEqual(password, config.DASHBOARD_PASSWORD)) {
    logger.warn({ event: "auth.login_failed" });
    return res.status(401).json({ error: "Incorrect password." });
  }

  res.cookie(
    security.SESSION_COOKIE,
    security.createSessionToken(),
    cookieOptions(req)
  );

  logger.info({ event: "auth.login_succeeded" });

  return res.json({ success: true });
});

app.post("/api/auth/logout", (req, res) => {
  const options = cookieOptions(req);
  delete options.maxAge;

  res.clearCookie(security.SESSION_COOKIE, options);

  return res.json({ success: true });
});

// ----------------------------------------------------------------- status

// Public, read-only: enough for the connection badge and the healthcheck.
// Pairing codes, phone numbers and session details stay on /api/session.
app.get("/api/status", (req, res) => {
  res.json({
    bot: config.BOT_NAME,
    ...bot.getStatus(),
    authRequired: security.authEnabled(),
    authenticated: security.isAuthorized(req)
  });
});

// Authenticated session detail used by the dashboard.
app.get("/api/session", security.requireAuth, (req, res) => {
  res.json(bot.getSessionInfo());
});

app.post("/api/pair", pairLimiter, security.requireAuth, async (req, res) => {
  const number = security.normalizePhone(req.body?.number);

  if (!number) {
    return res.status(400).json({
      error:
        "Enter a valid international phone number (10–15 digits with country code, no leading zero).",
      code: "invalid_number"
    });
  }

  try {
    const result = await bot.requestPairingCode(number);

    logger.info({ event: "pairing.code_delivered", reused: result.reused });

    return res.json({
      success: true,
      code: result.code,
      expiresAt: result.expiresAt,
      reused: result.reused
    });
  } catch (error) {
    return sendBotError(res, error, "Could not generate a pairing code.");
  }
});

app.post(
  "/api/session/reconnect",
  actionLimiter,
  security.requireAuth,
  async (req, res) => {
    try {
      await bot.reconnect();
      return res.json({ success: true, ...bot.getStatus() });
    } catch (error) {
      return sendBotError(res, error, "Could not reconnect to WhatsApp.");
    }
  }
);

app.post(
  "/api/session/reset",
  actionLimiter,
  security.requireAuth,
  async (req, res) => {
    // Resetting removes credentials: never allow it on a dashboard that has no
    // authentication configured at all.
    if (!security.authEnabled()) {
      return res.status(403).json({
        error:
          "Set DASHBOARD_PASSWORD (or API_TOKEN) before resetting the WhatsApp session.",
        code: "auth_required"
      });
    }

    if (req.body?.confirm !== "RESET") {
      return res.status(400).json({
        error: 'Type RESET to confirm resetting the WhatsApp session.',
        code: "confirm_required"
      });
    }

    try {
      const backup = await bot.resetSession();

      return res.json({ success: true, backup });
    } catch (error) {
      return sendBotError(res, error, "Could not reset the WhatsApp session.");
    }
  }
);

// --------------------------------------------------------------- settings

app.get("/api/settings", security.requireAuth, (req, res) => {
  res.json({
    settings: settings.get(),
    emojis: config.REACTION_EMOJIS,
    presenceOptions: ["available", "unavailable"]
  });
});

app.post("/api/settings", actionLimiter, security.requireAuth, async (req, res) => {
  const patch = {};

  for (const key of ["statusView", "statusReact"]) {
    if (typeof req.body?.[key] === "boolean") patch[key] = req.body[key];
  }

  if (req.body?.reactionEmoji !== undefined) {
    if (!config.REACTION_EMOJIS.includes(req.body.reactionEmoji)) {
      return res.status(400).json({
        error: `Unsupported reaction emoji. Use one of: ${config.REACTION_EMOJIS.join(" ")}`,
        code: "invalid_emoji"
      });
    }

    patch.reactionEmoji = req.body.reactionEmoji;
  }

  if (req.body?.presence !== undefined) {
    if (req.body.presence !== "available" && req.body.presence !== "unavailable") {
      return res.status(400).json({
        error: "Presence must be available or unavailable.",
        code: "invalid_presence"
      });
    }

    patch.presence = req.body.presence;
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({
      error: "No valid settings were provided.",
      code: "empty_patch"
    });
  }

  try {
    const updated = await settings.update(patch);

    if (patch.presence) {
      bot.applyPresence().catch(() => {});
    }

    return res.json({ success: true, settings: updated });
  } catch (error) {
    logger.error({ event: "settings.write_failed", message: error.message });

    return res.status(500).json({ error: "Could not save settings." });
  }
});

app.get("/api/commands", (req, res) => {
  res.json({
    bot: config.BOT_NAME,
    prefix: config.PREFIX,
    categories: commands.docs()
  });
});

// ----------------------------------------------------------------- errors

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((error, req, res, next) => {
  if (error.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large." });
  }

  logger.error({ event: "http.error", message: error.message });

  return res.status(500).json({ error: "Internal server error." });
});

const server = app.listen(config.PORT, () => {
  logger.info({ event: "server.started", port: Number(config.PORT) });

  if (!security.authEnabled()) {
    logger.warn({
      event: "auth.disabled",
      hint: "Set DASHBOARD_PASSWORD or API_TOKEN to protect pairing and session reset."
    });
  }

  // Only a real registered session is restored. An incomplete pairing attempt
  // stays idle so the owner can request a fresh code instead of seeing a
  // phantom "session exists" state.
  bot.autoStart();
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ event: "server.shutdown", signal });

  try {
    await bot.stop();
  } catch {
    // ignore shutdown errors
  }

  server.close(() => process.exit(0));

  if (typeof server.closeIdleConnections === "function") {
    server.closeIdleConnections();
  }

  // Force-close keep-alive sockets so shutdown never hangs on an open tab.
  setTimeout(() => {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error({
    event: "process.unhandled_rejection",
    message: reason instanceof Error ? reason.message : String(reason)
  });
});
