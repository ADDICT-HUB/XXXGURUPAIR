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

// Root endpoint to provide instructions
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>WhatsApp Pairing Server</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                    code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
                    h1 { color: #28a745; }
                </style>
            </head>
            <body>
                <h1>WhatsApp Session Pairing Service is Running!</h1>
                <p>This server facilitates Baileys session pairing via a 6-digit code or QR.</p>
                <h2>How to start a new pairing:</h2>
                <p>Make a GET request to the <code>/pair</code> endpoint.</p>
                <pre style="background: #e9ecef; padding: 15px; border-radius: 5px; display: inline-block;">
GET ${req.protocol}://${req.get('host')}/pair
                </pre>
                <p>The response will return a <code>code</code> and a <code>url</code> to follow for pairing.</p>
                <p>Example pairing URL: <code>/scan/123456</code></p>
                <hr>
                <p style="font-size: 0.9em; color: #6c757d;">
                    Check pairing status using: <code>/status/:code</code>
                </p>
            </body>
        </html>
    `);
});


const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// Simple in-memory map: code -> socket metadata
const pairingMap = {};
// 5 minutes in milliseconds. Sessions expire if not connected (status !== 'open')
const SESSION_TTL = 300 * 1000; 

// Create a 6-digit code
function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Function to clean up session files and memory entry
function cleanupSession(code) {
    const info = pairingMap[code];
    if (info) {
        // Close the socket if it's active
        if (info.sock && info.sock.end) {
            info.sock.end();
        }
        
        // Remove files from disk
        if (fs.existsSync(info.sessionPath)) {
            console.log(`Cleaning up session directory for code: ${code}`);
            fs.rmSync(info.sessionPath, { recursive: true, force: true });
        }

        delete pairingMap[code];
        console.log(`Session code expired and cleaned up: ${code}`);
    }
}

// Set up a periodic cleanup task
setInterval(() => {
    const now = Date.now();
    // Iterate over a copy of keys to safely delete from the original map
    for (const code in pairingMap) {
        const info = pairingMap[code];
        // Clean up if it's not 'open' (connected) and has exceeded TTL
        if (info.status !== 'open' && (now - info.createdAt) > SESSION_TTL) {
            cleanupSession(code);
        }
    }
}, 60000); // Check every minute


// Endpoint to create a pairing code (GET /pair)
app.get('/pair', async (req, res) => {
  try {
    // generate until unique
    let code = genCode();
    while (pairingMap[code]) code = genCode();

    const sessDir = path.join(SESSIONS_DIR, code);
    if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir);

    pairingMap[code] = {
      code,
      status: 'created',
      qr: null,
      pairingCode: null, // Field for 6-digit code
      sessionPath: sessDir,
      createdAt: Date.now() // Track creation time for cleanup
    };

    // Start the QR/Code pairing process in background (non-blocking)
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

// Serve a simple page that shows code, QR, and Button
app.get('/scan/:code', async (req, res) => {
  const code = req.params.code;
  const info = pairingMap[code];
  if (!info) return res.status(404).send('Invalid code or session expired');

  const qrDataUrl = info.qr || null;
  const pairingCode = info.pairingCode || null;

  let contentHtml = '';
  
  if (info.status === 'open') {
     contentHtml = `<h2>✅ Paired Successfully!</h2>`;
  } else if (pairingCode) {
      // Display the code prominently if it's available
      contentHtml = `
        <h2 style="color: green;">✅ Pairing Code Available</h2>
        <p>Enter this **6-digit code** into your WhatsApp Mobile App:</p>
        <div style="font-size: 3em; font-weight: bold; padding: 10px; border: 2px solid #333; display: inline-block; background: #eee; margin-bottom: 20px;">
            ${pairingCode}
        </div>
      `;
  } else if (qrDataUrl) {
      // Show QR and the button to request the code
      contentHtml = `
        <img src="${qrDataUrl}" width="320" />
        <p style="margin-top: 20px; font-size: 1.1em;">
            OR, use the 6-digit code instead:
        </p>
        <button onclick="alert('The 6-digit code should appear shortly. Refresh the page if it doesn\\'t show in 5 seconds.');" 
                style="padding: 10px 20px; font-size: 1.2em; cursor: pointer; background-color: #007bff; color: white; border: none; border-radius: 5px;">
            Get 6-Digit Code
        </button>
      `;
  } else {
      contentHtml = '<p>Waiting for pairing data...</p>';
  }

  const html = `
    <html>
      <head>
        <meta charset="utf-8">
        <title>Pairing - ${code}</title>
        ${info.status !== 'open' ? '<meta http-equiv="refresh" content="5">' : ''}
      </head>
      <body style="font-family: Arial; text-align:center; padding:30px;">
        <h1>WhatsApp Pairing</h1>
        <p><strong>Session ID:</strong> ${code}</p>
        <p>Status: <strong>${info.status}</strong></p>
        
        ${contentHtml}

        <p style="margin-top:20px;">
          <a href="/download-session/${code}">Download session JSON (when ready)</a>
        </p>
        <p style="font-size: 0.8em; color: gray;">
          This page ${info.status !== 'open' ? 'auto-refreshes every 5 seconds.' : 'is stable.'} 
          Session will expire if not connected.
        </p>
      </body>
    </html>
  `;
  res.send(html);
});

// Endpoint to check the pairing status (for API use)
app.get('/status/:code', (req, res) => {
    const code = req.params.code;
    const info = pairingMap[code];

    if (!info) {
        return res.status(404).json({ ok: false, status: 'expired' });
    }
    
    // Return a simplified status for API use
    const { status, qr, code: mapCode, error, createdAt, pairingCode } = info;
    const sessionReady = fs.existsSync(path.join(info.sessionPath, 'session_id.json'));

    res.json({
        ok: true,
        code: mapCode,
        status, // 'created', 'connecting', 'qr', 'code', 'open', 'closed', 'error'
        qrAvailable: !!qr,
        pairingCode: pairingCode || null, // Include the pairing code
        sessionReady, // true if session_id.json exists
        expiresIn: Math.max(0, SESSION_TTL - (Date.now() - createdAt)),
        error
    });
});


// Download session JSON saved when connection opens
app.get('/download-session/:code', async (req, res) => {
  const code = req.params.code;
  const info = pairingMap[code];
  if (!info) return res.status(404).json({ ok: false, error: 'invalid code or session expired' });

  const sessionFile = path.join(info.sessionPath, 'session_id.json');
  if (!fs.existsSync(sessionFile)) return res.status(404).json({ ok: false, error: 'session not ready' });

  res.download(sessionFile, `${code}-session.json`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Pairing server running on port', PORT);
  console.log('Root URL: GET /');
  console.log('Create pairing code: GET /pair');
  console.log('Check status: GET /status/:code');
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
    version,
    // Add the pairingCode callback
    pairingCode: (pCode) => {
        pairingMap[code].pairingCode = pCode;
        pairingMap[code].status = 'code';
        console.log(`Pairing code generated for ${code}: ${pCode}`);
    },
    // We explicitly disable legacy QR printing as we use the callback for both code and QR generation
    qr: true, 
  });

  // save reference for potential cleanup
  pairingMap[code].sock = sock;

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection } = update;

    if (qr) {
      // The QR mode is still active if the code hasn't been used yet.
      const qrImage = await qrcode.toDataURL(qr);
      pairingMap[code].qr = qrImage;
      // We set status to 'qr' only if we haven't received the pairing code yet
      if (pairingMap[code].status !== 'code') {
          pairingMap[code].status = 'qr';
      }
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
    }

    if (update.connection === 'close') {
      console.log('connection closed for', code, update);
      pairingMap[code].status = 'closed';
    }
  });

  sock.ev.on('creds.update', saveCreds);
}
