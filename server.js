const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// Simple in-memory map: code -> socket metadata
const pairingMap = {};

// Create a 6-digit code
function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Endpoint to create a pairing code (POST or GET)
app.get('/create-code', async (req, res) => {
  try {
    // generate until unique
    let code = genCode();
    while (pairingMap[code]) code = genCode();

    const sessDir = path.join(SESSIONS_DIR, code);
    if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir);

    // create auth state folder for this code using Baileys' multi-file auth state
    // We'll create a placeholder file; actual auth is created when connecting
    pairingMap[code] = {
      code,
      status: 'created',
      qr: null,
      sessionPath: sessDir
    };

    // Start the QR pairing process in background (non-blocking)
    startPairingForCode(code).catch(err => {
      console.error('pairing error for', code, err);
      pairingMap[code].status = 'error';
      pairingMap[code].error = String(err);
    });

    return res.json({ ok: true, code, url: `/scan/${code}` });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Serve a simple page that shows code and QR
app.get('/scan/:code', async (req, res) => {
  const code = req.params.code;
  const info = pairingMap[code];
  if (!info) return res.status(404).send('Invalid code');

  const qrDataUrl = info.qr || null;
  const html = `
    <html>
      <head><meta charset="utf-8"><title>Pairing - ${code}</title></head>
      <body style="font-family: Arial; text-align:center; padding:30px;">
        <h1>Scan with WhatsApp</h1>
        <p><strong>Pairing code:</strong> ${code}</p>
        <p>Status: <strong>${info.status}</strong></p>
        ${qrDataUrl ? `<img src="${qrDataUrl}" width="320" />` : '<p>Waiting for QR...</p>'}
        <p style="margin-top:20px;">
          <a href="/download-session/${code}">Download session JSON (when ready)</a>
        </p>
      </body>
    </html>
  `;
  res.send(html);
});

// Download session JSON saved when connection opens
app.get('/download-session/:code', async (req, res) => {
  const code = req.params.code;
  const info = pairingMap[code];
  if (!info) return res.status(404).json({ ok: false, error: 'invalid code' });

  const sessionFile = path.join(info.sessionPath, 'session_id.json');
  if (!fs.existsSync(sessionFile)) return res.status(404).json({ ok: false, error: 'session not ready' });

  res.download(sessionFile, `${code}-session.json`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Pairing server running on port', PORT);
  console.log('Create pairing code: GET /create-code');
});

async function startPairingForCode(code) {
  const info = pairingMap[code];
  if (!info) throw new Error('no pairing info');

  // fetch latest BAILEYS version
  const { version, isLatest } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(info.sessionPath);

  pairingMap[code].status = 'connecting';

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    version
  });

  // save reference for potential cleanup
  pairingMap[code].sock = sock;

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection } = update;

    if (qr) {
      // convert to data URL
      const qrImage = await qrcode.toDataURL(qr);
      pairingMap[code].qr = qrImage;
      pairingMap[code].status = 'qr';
      console.log('QR available for code', code);
    }

    if (connection === 'open') {
      pairingMap[code].status = 'open';
      try {
        await saveCreds(); // ensures credentials are written
      } catch (e) {
        console.warn('saveCreds failed', e);
      }

      // collect session files and zip into session_id.json structure
      const files = {};
      const filesOnDisk = fs.readdirSync(info.sessionPath);
      for (const f of filesOnDisk) {
        const txt = fs.readFileSync(path.join(info.sessionPath, f), 'utf8');
        files[f] = txt;
      }
      const outPath = path.join(info.sessionPath, 'session_id.json');
      fs.writeFileSync(outPath, JSON.stringify(files, null, 2), 'utf8');
      console.log('Session saved for', code);

      // optionally close the socket after saving
      // sock.end(); // keep session available
    }

    if (update.connection === 'close') {
      console.log('connection closed for', code, update);
      pairingMap[code].status = 'closed';
    }
  });

  sock.ev.on('creds.update', saveCreds);
}