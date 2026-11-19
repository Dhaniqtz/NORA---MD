"use strict";

// Backend base URL. Empty = same origin (dashboard served by the Baileys
// backend). Set it to the external backend origin when hosted separately.
const API_BASE = String(
  (window.NORA_CONFIG && window.NORA_CONFIG.apiBaseUrl) || ""
).replace(/\/+$/, "");

const STATUS_POLL_MS = 5000;
const STATUS_TIMEOUT_MS = 10000;
const PAIR_TIMEOUT_MS = 45000;
const DEFAULT_COOLDOWN_MS = 30000;

const STATE_LABELS = {
  online: "ONLINE",
  offline: "OFFLINE",
  connecting: "CONNECTING",
  reconnecting: "RECONNECTING"
};

const navStatus = document.getElementById("navStatus");
const statusDot = document.querySelector(".status-dot");
const connectionBadge = document.getElementById("connectionBadge");
const phoneInput = document.getElementById("phoneNumber");
const pairButton = document.getElementById("pairButton");
const codeResult = document.getElementById("codeResult");
const pairCode = document.getElementById("pairCode");
const copyButton = document.getElementById("copyButton");
const pairMessage = document.getElementById("pairMessage");
const authRow = document.getElementById("authRow");
const dashboardPassword = document.getElementById("dashboardPassword");
const unlockButton = document.getElementById("unlockButton");

let authRequired = false;
let pairingInFlight = false;
let statusInFlight = false;
let cooldownUntil = 0;
let cooldownTicker = null;

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

function setState(state) {
  const key = STATE_LABELS[state] ? state : "unknown";
  const label = STATE_LABELS[key] || "NO SIGNAL";

  navStatus.textContent = label;
  connectionBadge.textContent = label;
  connectionBadge.dataset.state = key;
  statusDot.dataset.state = key;
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
    pairButton.textContent = "REQUESTING CODE...";
    return;
  }

  pairButton.disabled = false;
  pairButton.innerHTML = "GENERATE PAIRING CODE <span>→</span>";
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

function showAuthPrompt(message) {
  authRequired = true;
  authRow.hidden = false;
  pairMessage.textContent = message;
  dashboardPassword.focus();
}

async function updateStatus() {
  if (statusInFlight) return;
  statusInFlight = true;

  try {
    const { ok, data } = await request("/api/status", { timeout: STATUS_TIMEOUT_MS });

    if (!ok || !data) throw new Error("Status request failed");

    setState(data.status);

    authRequired = Boolean(data.authRequired);
    const authenticated = Boolean(data.authenticated);
    authRow.hidden = !(authRequired && !authenticated);
  } catch {
    // Never guess the WhatsApp state: show that the backend is unreachable.
    setState("unknown");
  } finally {
    statusInFlight = false;
  }
}

pairButton.addEventListener("click", async () => {
  if (pairingInFlight || Date.now() < cooldownUntil) return;

  const number = phoneInput.value.replace(/[\s\-().]/g, "");

  if (!/^\+?[1-9]\d{9,14}$/.test(number)) {
    pairMessage.textContent =
      "Enter a valid international phone number (10–15 digits with country code).";
    return;
  }

  pairingInFlight = true;
  updatePairButton();
  pairMessage.textContent = "Requesting a pairing code from WhatsApp…";

  try {
    const { ok, status, data } = await request("/api/pair", {
      method: "POST",
      body: { number },
      timeout: PAIR_TIMEOUT_MS
    });

    if (ok && data && data.code) {
      pairCode.textContent = data.code;
      codeResult.hidden = false;
      pairMessage.textContent = "Enter this code in WhatsApp → Linked Devices.";
      startCooldown(DEFAULT_COOLDOWN_MS);
      return;
    }

    if (status === 401) {
      showAuthPrompt("Enter the dashboard password to generate a pairing code.");
      return;
    }

    if (status === 429) {
      const wait = Number(data && data.retryAfter) || 30;
      startCooldown(wait * 1000);
      pairMessage.textContent =
        (data && data.error) || `Please wait ${wait}s before trying again.`;
      return;
    }

    pairMessage.textContent =
      (data && data.error) || "Could not generate a pairing code.";
  } catch (error) {
    pairMessage.textContent =
      error.name === "AbortError"
        ? "The backend did not respond in time. Check the API URL and try again."
        : "Cannot reach the backend. Check the API URL and connection.";
  } finally {
    pairingInFlight = false;
    updatePairButton();
  }
});

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
      body: { password },
      timeout: STATUS_TIMEOUT_MS
    });

    if (ok) {
      authRow.hidden = true;
      dashboardPassword.value = "";
      pairMessage.textContent = "Dashboard unlocked. Generate your pairing code.";
    } else if (status === 429) {
      pairMessage.textContent =
        (data && data.error) || "Too many attempts. Try again later.";
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

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(pairCode.textContent);
    copyButton.textContent = "COPIED!";
  } catch {
    copyButton.textContent = "COPY FAILED";
  }

  setTimeout(() => {
    copyButton.textContent = "COPY CODE";
  }, 2000);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") updateStatus();
});

updatePairButton();
updateStatus();
setInterval(updateStatus, STATUS_POLL_MS);
