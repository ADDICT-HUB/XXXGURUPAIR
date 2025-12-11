# WhatsApp Session Pairing (Code mode)

This project provides a pairing server that creates a 6-digit code for pairing a WhatsApp session using Baileys.
Workflow:
1. Request `GET /create-code` — server returns `{ code, url }`.
2. Open `/scan/<code>` in a browser; page will show the pairing code and the QR when ready.
3. Scan QR with WhatsApp (use WhatsApp mobile app -> Linked devices -> Scan QR).
4. Once connected the session files are saved under `sessions/<code>/session_id.json`. You can download via `/download-session/<code>`.

## Setup

1. Install Node.js (16+).
2. Install dependencies:
   ```
   npm install
   ```
3. Start:
   ```
   npm start
   ```

## Deploy
- Works on Render, Railway, Heroku, etc. Make sure to expose port `3000` (or use environment variable `PORT`).

## Notes
- This pairing server creates a directory per code under `sessions/`.
- Keep the `sessions/<code>` files safe — they are your bot credentials.
- After pairing, take the `session_id.json` and move it to your main bot's session folder or adapt your bot to load multi-file auth state from it.