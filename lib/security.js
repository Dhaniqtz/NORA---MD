"use strict";

const crypto = require("crypto");

const config = require("../config");
const logger = require("./logger");

const SESSION_COOKIE = "nora_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));

  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authEnabled() {
  return Boolean(config.DASHBOARD_PASSWORD || config.API_TOKEN);
}

function sign(value) {
  return crypto
    .createHmac("sha256", config.cookieSecret)
    .update(value)
    .digest("base64url");
}

function createSessionToken() {
  const expires = String(Date.now() + SESSION_TTL_MS);
  return `${expires}.${sign(expires)}`;
}

function verifySessionToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return false;

  const [expires, signature] = token.split(".");
  if (!/^\d+$/.test(expires)) return false;
  if (!safeEqual(signature, sign(expires))) return false;

  return Number(expires) > Date.now();
}

function parseCookies(header) {
  const cookies = {};

  if (!header) return cookies;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (name) cookies[name] = decodeURIComponent(value);
  }

  return cookies;
}

function bearerAuthorized(req) {
  if (!config.API_TOKEN) return false;

  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  return Boolean(match && safeEqual(match[1].trim(), config.API_TOKEN));
}

function isAuthorized(req) {
  if (!authEnabled()) return true;
  if (bearerAuthorized(req)) return true;

  if (config.DASHBOARD_PASSWORD) {
    const cookies = parseCookies(req.get("cookie"));
    if (verifySessionToken(cookies[SESSION_COOKIE])) return true;
  }

  return false;
}

function requireAuth(req, res, next) {
  if (isAuthorized(req)) return next();

  res.status(401).json({ error: "Authentication required." });
}

function originAllowed(origin, req) {
  if (config.ALLOWED_ORIGINS.includes(origin)) return true;

  const host = req.get("host");
  if (!host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// CORS: only configured origins get credentialed CORS headers. There is no
// wildcard, so an unlisted site can neither read responses nor send a
// cross-site request to the API.
function cors(req, res, next) {
  const origin = req.get("origin");

  if (!origin) return next();

  if (!originAllowed(origin, req)) {
    logger.warn({ event: "cors.blocked" });
    return res.status(403).json({ error: "Origin not allowed." });
  }

  if (config.ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "600");
  }

  if (req.method === "OPTIONS") return res.status(204).end();

  return next();
}

function createRateLimiter({ windowMs, max, name }) {
  const hits = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.reset <= now) hits.delete(key);
    }
  }, windowMs);

  if (typeof cleanup.unref === "function") cleanup.unref();

  return function rateLimit(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.reset - now) / 1000));

      res.setHeader("Retry-After", String(retryAfter));
      logger.warn({ event: "rate_limit.blocked", limiter: name });

      return res.status(429).json({
        error: "Too many requests. Try again later.",
        retryAfter
      });
    }

    return next();
  };
}

function normalizePhone(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return null;

  const digits = String(raw).replace(/[\s\-().]/g, "");

  if (!/^\+?[1-9]\d{9,14}$/.test(digits)) return null;

  return digits.replace(/^\+/, "");
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  safeEqual,
  authEnabled,
  createSessionToken,
  isAuthorized,
  parseCookies,
  requireAuth,
  cors,
  createRateLimiter,
  normalizePhone
};
