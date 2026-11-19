"use strict";

const fs = require("fs");
const path = require("path");

const config = require("../config");

let cache = null;

function filePath() {
  return path.join(config.DATA_DIR, "settings.json");
}

function defaults() {
  return {
    statusView: config.STATUS_VIEW,
    statusReact: config.STATUS_REACT,
    reactionEmoji: config.DEFAULT_REACTION_EMOJI,
    presence: config.DEFAULT_PRESENCE
  };
}

function sanitize(raw) {
  const out = defaults();

  if (!raw || typeof raw !== "object") return out;

  if (typeof raw.statusView === "boolean") out.statusView = raw.statusView;
  if (typeof raw.statusReact === "boolean") out.statusReact = raw.statusReact;
  if (config.REACTION_EMOJIS.includes(raw.reactionEmoji)) {
    out.reactionEmoji = raw.reactionEmoji;
  }
  if (raw.presence === "available" || raw.presence === "unavailable") {
    out.presence = raw.presence;
  }

  return out;
}

function get() {
  if (!cache) {
    try {
      cache = sanitize(JSON.parse(fs.readFileSync(filePath(), "utf8")));
    } catch {
      cache = defaults();
    }
  }

  return { ...cache };
}

async function update(patch) {
  const next = sanitize({ ...get(), ...(patch || {}) });
  cache = next;

  await fs.promises.mkdir(config.DATA_DIR, { recursive: true });

  const target = filePath();
  const tmp = `${target}.${process.pid}.tmp`;

  await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2));
  await fs.promises.rename(tmp, target);

  return { ...next };
}

module.exports = {
  get,
  update,
  defaults
};
