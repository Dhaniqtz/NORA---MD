"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");

const config = require("./config");
const logger = require("./lib/logger");
const bot = require("./lib/bot");
const security = require("./lib/security");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

app.use(express.json({ limit: "10kb" }));
app.use(security.cors);
app.use(express.static(path.join(__dirname, "public")));

const pairLimiter = security.createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 5,
  name: "pair"
});

const loginLimiter = security.createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  name: "login"
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

app.get("/api/status", (req, res) => {
  res.json({
    bot: config.BOT_NAME,
    ...bot.getStatus(),
    authRequired: security.authEnabled(),
    authenticated: security.isAuthorized(req)
  });
});

app.post("/api/pair", pairLimiter, security.requireAuth, async (req, res) => {
  const number = security.normalizePhone(req.body?.number);

  if (!number) {
    return res.status(400).json({
      error:
        "Enter a valid international phone number (10–15 digits with country code, no leading zero)."
    });
  }

  const cooldown = bot.pairCooldownRemaining();

  if (cooldown > 0) {
    res.setHeader("Retry-After", String(cooldown));

    return res.status(429).json({
      error: `Please wait ${cooldown}s before requesting another pairing code.`,
      retryAfter: cooldown
    });
  }

  try {
    const code = await bot.requestPairingCode(number);

    logger.info({ event: "pairing.succeeded" });

    return res.json({ success: true, code });
  } catch (error) {
    const status = error.status || 500;

    if (status >= 500) {
      logger.error({ event: "pairing.failed", message: error.message });
    }

    return res.status(status).json({
      error: error.publicMessage || "Could not generate pairing code."
    });
  }
});

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
      hint: "Set DASHBOARD_PASSWORD or API_TOKEN to protect POST /api/pair."
    });
  }

  // Restore a previously paired WhatsApp session from persistent storage.
  if (bot.hasSession()) {
    bot.startBot().catch(() => {
      logger.error({ event: "bot.restore_failed" });
    });
  }
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
