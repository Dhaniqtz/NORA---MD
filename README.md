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
`.env` and `session/` are gitignored and must never be committed.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 3000) |
| `SESSION_DIR` | Baileys file auth state (default `./session`, keep it on persistent storage) |
| `ALLOWED_ORIGINS` | Extra CORS origins for a separately hosted dashboard (comma separated, no wildcard) |
| `DASHBOARD_PASSWORD` | Enables dashboard unlock; protects `POST /api/pair` |
| `API_TOKEN` | Optional bearer token for server-to-server clients |
| `SESSION_SECRET` | Optional HMAC key for dashboard session cookies |

The dashboard's backend URL is set in `public/config.js` (`apiBaseUrl`).
Leave it empty when the backend serves the dashboard; set it to the external
backend origin when they are hosted separately.

## API

- `GET /api/status` — real bot state (`online`, `offline`, `connecting`, `reconnecting`)
- `POST /api/pair` — real Baileys pairing code, body `{ "number": "947XXXXXXXX" }`
- `POST /api/auth/login` / `POST /api/auth/logout` — dashboard session (only when `DASHBOARD_PASSWORD` is set)

No database is used. WhatsApp credentials live only in `SESSION_DIR`.
