# Atlax Backend

Express.js backend (Node 20) for Atlax, integrating Pluggy (Open Finance), Mercado Pago (PIX) and Firebase Firestore.

## Run
- `npm start` → `node server.js` on port 5000 (host `0.0.0.0`)
- Workflow: **Start application** (webview, port 5000)

## Required Environment Variables / Secrets
- `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET` — Pluggy API credentials
- `MP_TOKEN` — Mercado Pago access token
- `FIREBASE_SERVICE_ACCOUNT` — full Firebase service-account JSON (string), **or** place `serviceAccountKey.json` at the project root

The server boots even when these are missing; endpoints that need them will warn/fail until configured.

## Endpoints
- `GET  /` — health/info
- `GET  /connect` — Pluggy connect token
- `POST /criar-usuario` — create Firestore user
- `GET  /saldo/:uid` — get balance
- `POST /deposito` — generate PIX payment
- `POST /webhook/mp` — Mercado Pago webhook
- `POST /saque` — request withdrawal
- `GET  /transacoes/:itemId` — list Pluggy transactions
- `POST /webhook/pluggy` — Pluggy webhook

## Deployment
Configured as **autoscale**, run command: `node server.js`.
