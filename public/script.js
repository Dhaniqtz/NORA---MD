"use strict";

// Backend base URL. Empty = same origin (dashboard served by the Baileys
// backend). Set it to the external backend origin when hosted separately.
const API_BASE = String(
  (window.NORA_CONFIG && window.NORA_CONFIG.apiBaseUrl) || ""
).replace(/\/+$/, "");

const STATUS_POLL_MS = 3000;
const STATUS_TIMEOUT_MS = 10000;
const PAIR_TIMEOUT_MS = 45000;

const STATE_LABELS = {
  online: "ONLINE",
  offline: "OFFLINE",
  connecting: "CONNECTING",
  reconnecting: "RECONNECTING"
};

const SESSION_LABELS = {
  empty: "NO SESSION",
  unregistered: "NOT LINKED",
  registered: "REGISTERED",
  logged_out: "LOGGED OUT",
  corrupted: "CORRUPTED"
};

const SESSION_NOTES = {
  empty: "No WhatsApp session on this server yet. Pair your account to begin.",
  unregistered:
    "A pairing attempt is stored but WhatsApp was never linked. Request a fresh code.",
  registered: "A linked WhatsApp session is stored on this server.",
  logged_out: "WhatsApp removed this linked device. Reset the session, then pair again.",
  corrupted: "The stored session file is unreadable. Reset the session, then pair again."
};

const navStatus = document.getElementById("navStatus");
const statusDot = document.querySelector(".status-dot");
const connectionBadge = document.getElementById("connectionBadge");
const phoneInput = document.getElementById("phoneNumber");
const pairButton = document.getElementById("pairButton");
const pairForm = document.getElementById("pairForm");
const codeResult = document.getElementById("codeResult");
const pairCode = document.getElementById("pairCode");
const codeTimer = document.getElementById("codeTimer");
const copyButton = document.getElementById("copyButton");
const pairMessage = document.getElementById("pairMessage");
const authRow = document.getElementById("authRow");
const dashboardPassword = document.getElementById("dashboardPassword");
const unlockButton = document.getElementById("unlockButton");
const sessionStateEl = document.getElementById("sessionState");
const sessionNumberEl = document.getElementById("sessionNumber");
const sessionUptimeEl = document.getElementById("sessionUptime");
const sessionReconnectsEl = document.getElementById("sessionReconnects");
const sessionNote = document.getElementById("sessionNote");
const linkedActions = document.getElementById("linkedActions");
const linkedMessage = document.getElementById("linkedMessage");
const reconnectButton = document.getElementById("reconnectButton");
const resetZone = document.getElementById("resetZone");
const resetConfirm = document.getElementById("resetConfirm");
const resetButton = document.getElementById("resetButton");
const automationSection = document.getElementById("automation");
const toggleView = document.getElementById("toggleView");
const toggleReact = document.getElementById("toggleReact");
const emojiPicker = document.getElementById("emojiPicker");
const presencePicker = document.getElementById("presencePicker");
const settingsMessage = document.getElementById("settingsMessage");
const commandDocs = document.getElementById("commandDocs");
const toasts = document.getElementById("toasts");

let authRequired = false;
let authenticated = true;
let pairingInFlight = false;
let statusInFlight = false;
let cooldownUntil = 0;
let cooldownTicker = null;
let codeExpiresAt = 0;
let emojis = ["❤️", "🔥", "😂", "🥹", "💙"];
let currentSettings = null;
let lastStatus = null;
let sessionState = "empty";

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

async function request(path, { method = "GET", body, timeout = STATUS_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(apiUrl(path), {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function showToast(message, type = "success") {
  if (!message) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toasts.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 300);
  }, 4200);
}

function setState(state) {
  const key = STATE_LABELS[state] ? state : "unknown";
  const label = STATE_LABELS[key] || "NO SIGNAL";

  navStatus.textContent = label;
  connectionBadge.textContent = label;
  connectionBadge.dataset.state = key;
  statusDot.dataset.state = key;
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function updatePairButton() {
  const now = Date.now();

  if (cooldownUntil > now) {
    pairButton.disabled = true;
    pairButton.textContent = `WAIT ${Math.ceil((cooldownUntil - now) / 1000)}s`;
    return;
  }

  if (pairingInFlight) {
    pairButton.disabled = true;
    pairButton.textContent = "REQUESTING CODE…";
    return;
  }

  pairButton.disabled = false;
  pairButton.innerHTML = "PAIR WHATSAPP <span>→</span>";
}

function startCooldown(ms) {
  cooldownUntil = Date.now() + ms;

  if (cooldownTicker) clearInterval(cooldownTicker);

  cooldownTicker = setInterval(() => {
    updatePairButton();

    if (Date.now() >= cooldownUntil) {
      clearInterval(cooldownTicker);
      cooldownTicker = null;
    }
  }, 500);

  updatePairButton();
}

function showCode(code, expiresAt) {
  if (!code) {
    codeResult.hidden = true;
    return;
  }

  pairCode.textContent = code;
  codeExpiresAt = Number(expiresAt) || 0;
  codeResult.hidden = false;
  tickCodeTimer();
}

function tickCodeTimer() {
  if (codeResult.hidden) return;

  const left = codeExpiresAt - Date.now();

  if (left <= 0) {
    codeTimer.textContent = "Code expired — request a new one.";
    return;
  }

  codeTimer.textContent = `Expires in ${formatCountdown(left)}`;
}

function setLocked(locked) {
  authRow.hidden = !locked;

  if (locked) {
    pairForm.hidden = true;
    linkedActions.hidden = true;
    resetZone.hidden = true;
    automationSection.classList.add("locked");
    return;
  }

  automationSection.classList.remove("locked");
  renderSession();
}

function showAuthPrompt(message) {
  authRequired = true;
  authenticated = false;
  setLocked(true);
  pairMessage.textContent = message || "Enter the dashboard password to continue.";
  dashboardPassword.focus();
}

function renderSession(data) {
  if (!data) return;

  sessionState = data.session.state;
  const locked = authRequired && !authenticated;

  sessionStateEl.textContent = SESSION_LABELS[sessionState] || sessionState.toUpperCase();
  sessionNumberEl.textContent = data.session.number || "—";
  sessionUptimeEl.textContent = formatUptime(data.uptimeSeconds);
  sessionReconnectsEl.textContent = String(data.reconnectAttempt || 0);

  sessionNote.textContent =
    (data.lastError && data.lastError.message) ||
    SESSION_NOTES[sessionState] ||
    "";

  if (locked) return;

  const canPair = sessionState === "empty" || sessionState === "unregistered";
  const linked = sessionState === "registered";

  pairForm.hidden = !canPair;
  linkedActions.hidden = !linked;
  resetZone.hidden = sessionState === "empty";

  if (linked) {
    linkedMessage.textContent =
      data.status === "online"
        ? "Linked and connected. NORA MD is online."
        : "Session linked but offline. Reconnect to bring NORA MD online.";
  }

  if (data.pairing && data.pairing.code) {
    showCode(data.pairing.code, data.pairing.expiresAt);
  } else if (data.pairing && !data.pairing.active) {
    codeResult.hidden = true;
    pairMessage.textContent =
      "The pairing code expired before linking. Request a new code.";
  } else if (!pairingInFlight) {
    codeResult.hidden = true;
  }
}

async function refreshSession() {
  if (authRequired && !authenticated) return;

  const { ok, data } = await request("/api/session");

  if (!ok || !data) return;

  renderSession(data);
}

async function refreshStatus() {
  if (statusInFlight) return;
  statusInFlight = true;

  try {
    const { ok, data } = await request("/api/status");

    if (!ok || !data) throw new Error("Status request failed");

    setState(data.status);

    authRequired = Boolean(data.authRequired);
    authenticated = Boolean(data.authenticated);

    if (authRequired && !authenticated) {
      setLocked(true);
    } else {
      setLocked(false);
      await refreshSession();
    }

    if (lastStatus !== "online" && data.status === "online") {
      showToast("WhatsApp connected — NORA MD is online.", "success");
    }

    lastStatus = data.status;
  } catch {
    // Never guess the WhatsApp state: show that the backend is unreachable.
    setState("unknown");
    sessionNote.textContent = "Cannot reach the backend. Check the API URL and connection.";
  } finally {
    statusInFlight = false;
  }
}

// ------------------------------------------------------------------ pairing

pairButton.addEventListener("click", async () => {
  if (pairingInFlight || Date.now() < cooldownUntil) return;

  const number = phoneInput.value.replace(/[\s\-().]/g, "");

  if (!/^\+?[1-9]\d{9,14}$/.test(number)) {
    pairMessage.textContent =
      "Enter a valid international phone number (10–15 digits with country code).";
    showToast("That phone number is not valid.", "error");
    return;
  }

  pairingInFlight = true;
  updatePairButton();
  pairMessage.textContent = "Requesting a real pairing code from WhatsApp…";
  setState("connecting");

  try {
    const { ok, status, data } = await request("/api/pair", {
      method: "POST",
      body: { number },
      timeout: PAIR_TIMEOUT_MS
    });

    if (ok && data && data.code) {
      showCode(data.code, data.expiresAt);
      pairMessage.textContent =
        "Enter this code in WhatsApp → Linked Devices → Link with phone number.";
      showToast(data.reused ? "Existing pairing code restored." : "Pairing code ready.", "success");
      startCooldown(30000);
      await refreshStatus();
      return;
    }

    if (status === 401) {
      showAuthPrompt("Enter the dashboard password to pair a device.");
      return;
    }

    if (status === 429) {
      const wait = Number(data && data.retryAfter) || 30;
      startCooldown(wait * 1000);
      pairMessage.textContent = (data && data.error) || `Please wait ${wait}s.`;
      showToast("Please wait before requesting another code.", "error");
      return;
    }

    pairMessage.textContent =
      (data && data.error) || "Could not generate a pairing code.";
    showToast((data && data.error) || "Pairing failed.", "error");
    await refreshStatus();
  } catch (error) {
    pairMessage.textContent =
      error.name === "AbortError"
        ? "The backend did not respond in time. Check the API URL and try again."
        : "Cannot reach the backend. Check the API URL and connection.";
    showToast("Backend unreachable.", "error");
    setState("unknown");
  } finally {
    pairingInFlight = false;
    updatePairButton();
  }
});

copyButton.addEventListener("click", async () => {
  const code = pairCode.textContent;

  try {
    await navigator.clipboard.writeText(code);
    copyButton.textContent = "COPIED!";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(pairCode);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copyButton.textContent = "SELECTED — COPY";
  }

  setTimeout(() => {
    copyButton.textContent = "COPY CODE";
  }, 2200);
});

reconnectButton.addEventListener("click", async () => {
  reconnectButton.disabled = true;
  reconnectButton.textContent = "RECONNECTING…";

  try {
    const { ok, status, data } = await request("/api/session/reconnect", {
      method: "POST",
      timeout: PAIR_TIMEOUT_MS
    });

    if (ok) {
      showToast("Reconnecting to WhatsApp…", "success");
    } else if (status === 401) {
      showAuthPrompt("Enter the dashboard password to reconnect.");
    } else {
      showToast((data && data.error) || "Could not reconnect.", "error");
    }
  } catch {
    showToast("Backend unreachable.", "error");
  } finally {
    reconnectButton.disabled = false;
    reconnectButton.innerHTML = "RECONNECT WHATSAPP <span>↻</span>";
    refreshStatus();
  }
});

resetButton.addEventListener("click", async () => {
  if (resetConfirm.value.trim().toUpperCase() !== "RESET") {
    showToast('Type RESET to confirm.', "error");
    resetConfirm.focus();
    return;
  }

  resetButton.disabled = true;
  resetButton.textContent = "RESETTING…";

  try {
    const { ok, status, data } = await request("/api/session/reset", {
      method: "POST",
      body: { confirm: "RESET" }
    });

    if (ok) {
      resetConfirm.value = "";
      codeResult.hidden = true;
      showToast(
        data && data.backup
          ? "Session reset. Backup kept on the server."
          : "Session reset.",
        "success"
      );
      await refreshStatus();
    } else if (status === 401) {
      showAuthPrompt("Enter the dashboard password to reset the session.");
    } else {
      showToast((data && data.error) || "Could not reset the session.", "error");
    }
  } catch {
    showToast("Backend unreachable.", "error");
  } finally {
    resetButton.disabled = false;
    resetButton.textContent = "RESET";
  }
});

// ------------------------------------------------------------------- auth

unlockButton.addEventListener("click", async () => {
  const password = dashboardPassword.value;

  if (!password) {
    pairMessage.textContent = "Enter the dashboard password.";
    return;
  }

  unlockButton.disabled = true;

  try {
    const { ok, status, data } = await request("/api/auth/login", {
      method: "POST",
      body: { password }
    });

    if (ok) {
      authRow.hidden = true;
      authenticated = true;
      dashboardPassword.value = "";
      showToast("Dashboard unlocked.", "success");
      await refreshStatus();
      await loadSettings();
    } else if (status === 429) {
      pairMessage.textContent = (data && data.error) || "Too many attempts. Try again later.";
    } else {
      pairMessage.textContent = (data && data.error) || "Incorrect password.";
    }
  } catch {
    pairMessage.textContent = "Cannot reach the backend. Check the API URL and connection.";
  } finally {
    unlockButton.disabled = false;
  }
});

dashboardPassword.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    unlockButton.click();
  }
});

// --------------------------------------------------------------- settings

function renderSettings(current) {
  currentSettings = current;

  toggleView.setAttribute("aria-checked", String(Boolean(current.statusView)));
  toggleView.classList.toggle("on", Boolean(current.statusView));
  toggleReact.setAttribute("aria-checked", String(Boolean(current.statusReact)));
  toggleReact.classList.toggle("on", Boolean(current.statusReact));

  for (const button of emojiPicker.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.emoji === current.reactionEmoji);
  }

  for (const button of presencePicker.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.presence === current.presence);
  }
}

function buildEmojiPicker() {
  emojiPicker.textContent = "";

  for (const emoji of emojis) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.emoji = emoji;
    button.textContent = emoji;
    button.setAttribute("aria-label", `React with ${emoji}`);
    emojiPicker.appendChild(button);
  }
}

async function loadSettings() {
  if (authRequired && !authenticated) return;

  const { ok, data } = await request("/api/settings");

  if (!ok || !data) return;

  if (Array.isArray(data.emojis) && data.emojis.length) {
    emojis = data.emojis;
    buildEmojiPicker();
  }

  renderSettings(data.settings);
}

async function saveSetting(patch) {
  if (authRequired && !authenticated) {
    showAuthPrompt("Unlock the dashboard to change automation settings.");
    return;
  }

  settingsMessage.textContent = "Saving…";

  try {
    const { ok, status, data } = await request("/api/settings", {
      method: "POST",
      body: patch
    });

    if (ok && data && data.settings) {
      renderSettings(data.settings);
      settingsMessage.textContent = "Saved to the backend.";
      showToast("Settings saved.", "success");
    } else if (status === 401) {
      showAuthPrompt("Unlock the dashboard to change automation settings.");
    } else {
      settingsMessage.textContent = (data && data.error) || "Could not save settings.";
      showToast((data && data.error) || "Could not save settings.", "error");
    }
  } catch {
    settingsMessage.textContent = "Cannot reach the backend.";
    showToast("Backend unreachable.", "error");
  }
}

toggleView.addEventListener("click", () => {
  const next = !(currentSettings && currentSettings.statusView);
  saveSetting({ statusView: next });
});

toggleReact.addEventListener("click", () => {
  const next = !(currentSettings && currentSettings.statusReact);
  saveSetting({ statusReact: next });
});

emojiPicker.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-emoji]");
  if (!button) return;
  saveSetting({ reactionEmoji: button.dataset.emoji });
});

presencePicker.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-presence]");
  if (!button) return;
  saveSetting({ presence: button.dataset.presence });
});

// ---------------------------------------------------------------- commands

async function loadCommands() {
  const { ok, data } = await request("/api/commands");

  if (!ok || !data || !Array.isArray(data.categories)) {
    commandDocs.textContent = "Command list unavailable.";
    return;
  }

  commandDocs.textContent = "";

  for (const group of data.categories) {
    const card = document.createElement("article");
    card.className = "doc-card";

    const heading = document.createElement("h3");
    heading.textContent = group.category;
    card.appendChild(heading);

    for (const command of group.commands) {
      const row = document.createElement("div");
      row.className = "doc-row";

      const code = document.createElement("code");
      code.textContent = `${data.prefix}${command.name}${command.usage ? ` ${command.usage}` : ""}`;
      row.appendChild(code);

      const description = document.createElement("p");
      description.textContent = command.description;
      row.appendChild(description);

      if (command.ownerOnly) {
        const lock = document.createElement("span");
        lock.className = "doc-lock";
        lock.textContent = "OWNER";
        row.appendChild(lock);
      }

      card.appendChild(row);
    }

    commandDocs.appendChild(card);
  }
}

// ------------------------------------------------------------------- boot

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshStatus();
});

updatePairButton();
setInterval(tickCodeTimer, 1000);
refreshStatus();
loadSettings();
loadCommands();
setInterval(refreshStatus, STATUS_POLL_MS);
