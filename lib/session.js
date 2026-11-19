"use strict";

const fs = require("fs");
const path = require("path");

const config = require("../config");
const logger = require("./logger");

const CREDS_FILE = "creds.json";

function credsPath() {
  return path.join(config.SESSION_DIR, CREDS_FILE);
}

function flagPath() {
  return path.join(config.DATA_DIR, "session-invalid.json");
}

// A previous connection may have been revoked from the phone. Baileys keeps
// the (now useless) creds file, so the reason is remembered separately.
function readFlag() {
  try {
    const raw = JSON.parse(fs.readFileSync(flagPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function markInvalid(reason) {
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(
      flagPath(),
      JSON.stringify({ reason, at: new Date().toISOString() }, null, 2)
    );
  } catch (error) {
    logger.error({ event: "session.flag_write_failed", message: error.message });
  }
}

function clearInvalid() {
  try {
    fs.rmSync(flagPath(), { force: true });
  } catch {
    // nothing to clear
  }
}

/**
 * Classifies the stored Baileys auth state.
 *
 * state:
 *   empty        - no creds.json (never paired)
 *   unregistered - creds.json exists but pairing never completed
 *   registered   - creds.json is registered (a real linked session)
 *   logged_out   - registered before, but WhatsApp removed this device
 *   corrupted    - creds.json unreadable or missing required keys
 */
function read() {
  const file = credsPath();
  const flag = readFlag();

  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }

  if (!stat) {
    return {
      state: "empty",
      registered: false,
      me: null,
      updatedAt: null,
      detail: "No WhatsApp session stored on this server."
    };
  }

  const updatedAt = stat.mtime.toISOString();
  let creds;

  try {
    creds = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {
      state: "corrupted",
      registered: false,
      me: null,
      updatedAt,
      detail: "creds.json is not valid JSON."
    };
  }

  if (
    !creds ||
    typeof creds !== "object" ||
    !creds.noiseKey ||
    !creds.signedIdentityKey ||
    !creds.registrationId
  ) {
    return {
      state: "corrupted",
      registered: false,
      me: null,
      updatedAt,
      detail: "creds.json is missing required WhatsApp keys."
    };
  }

  const registered = creds.registered === true;
  const invalid = Boolean(flag);

  let state = "unregistered";
  if (registered) state = invalid ? "logged_out" : "registered";

  return {
    state,
    registered,
    me: creds.me || null,
    updatedAt,
    detail: registered
      ? invalid
        ? "WhatsApp removed this linked device."
        : "A linked WhatsApp session is stored on this server."
      : "A pairing attempt started but never completed.",
    invalidReason: invalid ? flag.reason || null : null
  };
}

function isRegistered() {
  return read().registered === true;
}

/**
 * Copies the stored session into DATA_DIR/backups and removes the live one.
 * Nothing is ever deleted without a copy being kept first.
 */
async function backupAndClear() {
  const dir = config.SESSION_DIR;
  let hasFiles = false;

  try {
    hasFiles = fs.readdirSync(dir).length > 0;
  } catch {
    hasFiles = false;
  }

  let backup = null;

  if (hasFiles) {
    const backupsRoot = path.join(config.DATA_DIR, "backups");
    await fs.promises.mkdir(backupsRoot, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(backupsRoot, `session-${stamp}`);

    await fs.promises.cp(dir, target, { recursive: true });
    backup = path.basename(target);
  }

  await fs.promises.rm(dir, { recursive: true, force: true });
  clearInvalid();

  return backup;
}

module.exports = {
  read,
  isRegistered,
  markInvalid,
  clearInvalid,
  backupAndClear
};
