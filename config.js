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

module.exports = {
  BOT_NAME: "NORA MD",
  OWNER_NAME: "DHANI",
  PREFIX: ".",

  DEFAULT_PRESENCE: "unavailable",

  STATUS_VIEW: true,
  STATUS_REACT: true,

  REACTION_EMOJIS: [
    "❤️",
    "🔥",
    "🧠",
    "👊",
    "🩶",
    "💯",
    "🫀",
    "🙄",
    "🥹",
    "🤭",
    "👀",
    "🤝",
    "🤍",
    "🥹",
    "💙"
  ],

  PORT: process.env.PORT || 3000,

  SESSION_DIR: process.env.SESSION_DIR
    ? path.resolve(process.env.SESSION_DIR)
    : path.join(__dirname, "session"),

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
  RECONNECT_BASE_DELAY: Number(process.env.RECONNECT_BASE_DELAY || 5000),
  RECONNECT_MAX_DELAY: Number(process.env.RECONNECT_MAX_DELAY || 60000)
};
