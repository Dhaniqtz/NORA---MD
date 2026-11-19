# NORA---MD

NORA MD — WhatsApp automation bot (Baileys) with a Black / White / Ice Blue dashboard.

## Run

```bash
npm install
npm start        # node index.js
npm run dev      # node --watch index.js
```

Requires Node.js 20 or later.

## Configuration

All settings come from environment variables (see `.env.example`).
`.env`, `session/` and `data/` are gitignored and must never be committed.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 3000) |
| `SESSION_DIR` | Baileys file auth state (default `./session`, keep it on persistent storage) |
| `DATA_DIR` | Runtime settings + session backups (default `./data`) |
| `OWNER_NUMBER` | Optional owner number (digits, international). Unset = the linked account is the owner |
| `ALLOWED_ORIGINS` | Extra CORS origins for a separately hosted dashboard (comma separated, no wildcard) |
| `DASHBOARD_PASSWORD` | Enables dashboard unlock; protects pairing, settings and session reset |
| `API_TOKEN` | Optional bearer token for server-to-server clients |
| `SESSION_SECRET` | Optional HMAC key for dashboard session cookies |
| `PAIR_CODE_TTL_MS` | How long an issued pairing code is shown as active (default 180000) |
| `PAIR_SOCKET_TIMEOUT_MS` | Max wait for the WhatsApp socket before pairing (default 20000) |
| `PAIR_COOLDOWN_MS` | Minimum gap between pairing code requests (default 30000) |

The dashboard's backend URL is set in `public/config.js` (`apiBaseUrl`).
Leave it empty when the backend serves the dashboard; set it to the external
backend origin when they are hosted separately.

## WhatsApp session states

The server never treats "a creds file exists" as "paired". `lib/session.js`
reads `creds.json` and reports one of:

| State | Meaning | What the dashboard does |
| --- | --- | --- |
| `empty` | Never paired | Pairing form |
| `unregistered` | Unfinished pairing attempt | Pairing form (a fresh code is allowed) |
| `registered` | Real linked session | Reconnect instead of pairing |
| `logged_out` | WhatsApp removed the device | Reset session, then pair |
| `corrupted` | Unreadable creds file | Reset session, then pair |

Only a `registered` session is restored at boot. Resetting copies `session/`
to `data/backups/session-<timestamp>/` before removing it, so nothing is lost.

## API

- `GET /api/status` — public: `status`, `registered`, `sessionState`, `pairingActive`, `authRequired`
- `GET /api/session` — authenticated: session detail, active pairing code, last error, counters
- `POST /api/pair` — real Baileys pairing code, body `{ "number": "947XXXXXXXX" }`
- `POST /api/session/reconnect` — reconnect a registered session
- `POST /api/session/reset` — body `{ "confirm": "RESET" }`; backs up then removes the session. Requires `DASHBOARD_PASSWORD` or `API_TOKEN` to be configured
- `GET`/`POST /api/settings` — status automation (`statusView`, `statusReact`, `reactionEmoji`, `presence`)
- `GET /api/commands` — command documentation used by the dashboard
- `POST /api/auth/login` / `POST /api/auth/logout` — dashboard session (only when `DASHBOARD_PASSWORD` is set)

## Commands

General: `.menu` `.help` `.ping` `.alive` `.runtime` `.owner` `.status`

Presence (owner): `.online` `.offline`

Status (owner): `.statusview on|off` `.statusreact on|off` `.setreact ❤️|🔥|😂|🥹|💙` `.statusinfo`

Media: `.getdp` `.save` `.vv`

Owner: `.restart` `.settings` `.blocklist` `.unblock <number>`

`.save` works on media you reply to; view-once media is protected by WhatsApp and
is never bypassed. `.restart` reconnects the socket without deleting the session.

No database is used. WhatsApp credentials live only in `SESSION_DIR`; settings and
session backups live only in `DATA_DIR`.
