"use strict";

const pino = require("pino");

// Structured JSON logs. Sensitive values (phone numbers, pairing codes,
// credentials, cookies) are redacted so they never reach server logs.
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: "nora-md" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "number",
      "code",
      "password",
      "req.headers.authorization",
      "req.headers.cookie",
      "*.number",
      "*.code",
      "*.password"
    ],
    censor: "[redacted]"
  }
});

module.exports = logger;
