"use strict";

const path = require("path");
const crypto = require("crypto");

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// Sandbox preview only: the preview proxy forwards the page's public Origin
// while the request Host is the sandbox host, so the same-origin check cannot
// match it. Gated on the exact preview flag; unset or any other value leaves
// ALLOWED_ORIGINS untouched.
if (process.env.BASE44_PREVIEW_MODE === "1" && process.env.PREVIEW_ORIGIN) {
  const previewOrigin = process.env.PREVIEW_ORIGIN.trim().replace(/\/+$/, "");

  try {
    const parsed = new URL(previewOrigin);

    if (parsed.protocol === "https:" && !allowedOrigins.includes(previewOrigin)) {
      allowedOrigins.push(previewOrigin);
    }
  } catch {
    // Ignore an unset/malformed preview origin.
  }
}

const dashboardPassword = process.env.DASHBOARD_PASSWORD || "";
const apiToken = process.env.API_TOKEN || "";

function resolveDir(value, fallback) {
  return value ? path.resolve(value) : fallback;
}

module.exports = {
  BOT_NAME: "NORA MD",
  OWNER_NAME: "DHANI",
  PREFIX: ".",

  // Presence the bot returns to on connect. "unavailable" = appear offline.
  DEFAULT_PRESENCE: "unavailable",

  // Status automation defaults. Reactions are opt-in so the bot never reacts
  // to a contact's status until the owner enables it.
  STATUS_VIEW: true,
  STATUS_REACT: false,
  DEFAULT_REACTION_EMOJI: "❤️",

  REACTION_EMOJIS: ["❤️", "🔥", "😂", "🥹", "💙"],

  PORT: process.env.PORT || 3000,

  SESSION_DIR: resolveDir(process.env.SESSION_DIR, path.join(__dirname, "session")),
  DATA_DIR: resolveDir(process.env.DATA_DIR, path.join(__dirname, "data")),

  // Optional: the owner's number in international format (digits only). When
  // unset, the linked account itself is treated as the owner.
  OWNER_NUMBER: (process.env.OWNER_NUMBER || "").replace(/\D/g, ""),

  ALLOWED_ORIGINS: allowedOrigins,
  DASHBOARD_PASSWORD: dashboardPassword,
  API_TOKEN: apiToken,

  // HMAC key for the dashboard session cookie. Derived from the configured
  // password when no dedicated secret is supplied, so no value ships in code.
  cookieSecret:
    process.env.SESSION_SECRET ||
    crypto
      .createHash("sha256")
      .update(`nora-md-session:${dashboardPassword}`)
      .digest("hex"),

  PAIR_COOLDOWN_MS: Number(process.env.PAIR_COOLDOWN_MS || 30000),
  PAIR_CODE_TTL_MS: Number(process.env.PAIR_CODE_TTL_MS || 180000),
  PAIR_SOCKET_TIMEOUT_MS: Number(process.env.PAIR_SOCKET_TIMEOUT_MS || 20000),
  RECONNECT_BASE_DELAY: Number(process.env.RECONNECT_BASE_DELAY || 5000),
  RECONNECT_MAX_DELAY: Number(process.env.RECONNECT_MAX_DELAY || 60000)
};
