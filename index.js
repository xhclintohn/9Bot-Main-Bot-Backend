// index.js
// Toxic-MD Pairing API (stable pairing edition)
// Reworked to wait for connection.open before requesting pairing code.
// Preserves your GitHub & Heroku deploy flow.

const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const axios = require('axios');
const cors = require('cors');
const simpleGit = require('simple-git');

// Polyfill fetch for Node (works even if Node runtime doesn't provide fetch)
global.fetch = global.fetch || ((...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args)));

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers
} = require("@whiskeysockets/baileys");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Environment variables
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const tempDir = path.join(__dirname, 'temp-repo');

// Store active sessions
const activeSessions = new Map();

// Helper functions
function removeFile(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function makeid() {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 10; i++) {
    result += characters.charAt(Math.floor(Math.random() * Math.random() * characters.length));
  }
  return result;
}

// Clone and push to GitHub
async function saveToGitHubAndDeploy(sessionPath, userId, phoneNumber) {
  try {
    console.log(`🚀 Starting GitHub save and deployment for user: ${userId}`);

    // Clone repo
    const git = simpleGit();
    const repoUrl = `https://${GITHUB_TOKEN}@github.com/thebitnomad/9bot.git`;

    if (fs.existsSync(tempDir)) {
      removeFile(tempDir);
    }

    console.log('📥 Cloning GitHub repository...');
    await git.clone(repoUrl, tempDir);

    // Copy session files
    const repoSessionPath = path.join(tempDir, 'Session');
    if (!fs.existsSync(repoSessionPath)) {
      fs.mkdirSync(repoSessionPath, { recursive: true });
    }

    console.log('📁 Copying session files...');
    const sessionFiles = fs.readdirSync(sessionPath);
    for (const file of sessionFiles) {
      const sourcePath = path.join(sessionPath, file);
      const destPath = path.join(repoSessionPath, file);
      fs.copyFileSync(sourcePath, destPath);
    }

    console.log('💾 Committing to GitHub...');
    const gitRepo = simpleGit(tempDir);
    await gitRepo.add('.');
    await gitRepo.commit(`Add session for user ${userId}`);
    await gitRepo.push('origin', 'main');

    console.log(`✅ Session saved to GitHub for user: ${userId}`);

    // Deploy to Heroku
    await deployToHeroku(userId);

  } catch (error) {
    console.error('❌ GitHub save/deploy error:', error);
    throw error;
  }
}

// Deploy to Heroku
async function deployToHeroku(userId) {
  try {
    const appName = `toxic-md-${userId}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, 30);

    console.log(`🔧 Creating Heroku app: ${appName}`);

    // Create Heroku app
    await axios.post(
      'https://api.heroku.com/apps',
      { name: appName },
      {
        headers: {
          'Authorization': `Bearer ${HEROKU_API_KEY}`,
          'Accept': 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    // Configure environment
    await axios.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      { USER_ID: userId },
      {
        headers: {
          'Authorization': `Bearer ${HEROKU_API_KEY}`,
          'Accept': 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    // Build from GitHub
    await axios.post(
      `https://api.heroku.com/apps/${appName}/builds`,
      {
        source_blob: {
          url: 'https://github.com/thebitnomad/9bot/tarball/main/'
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${HEROKU_API_KEY}`,
          'Accept': 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    console.log(`✅ Bot deployed successfully for user ${userId}: ${appName}`);

  } catch (error) {
    console.error('❌ Heroku deployment error:', error.response?.data || error.message);
    throw error;
  }
}

// Utility: attempt to fetch Baileys version, fallback to a safe static version
async function getBaileysVersion() {
  try {
    const url = 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json';
    const resp = await fetch(url, { timeout: 5000 });
    if (!resp.ok) throw new Error('Failed to fetch version JSON');
    const data = await resp.json();
    if (Array.isArray(data.version)) return data.version;
  } catch (e) {
    console.warn('⚠️ Could not fetch Baileys version dynamically, using fallback. Reason:', e.message || e);
  }
  // Fallback version (kept conservative)
  return [2, 3000, 5];
}

// Routes
app.get('/', (req, res) => {
  res.json({
    status: 'Toxic-MD Pairing API',
    version: '1.0',
    message: 'Server is running!'
  });
});

// Pairing endpoint - STABLE pairing (wait for socket open then request pairing code)
app.post('/pair', async (req, res) => {
  console.log('📞 Pairing request received:', req.body);

  const { phoneNumber, userId } = req.body;

  if (!phoneNumber || !userId) {
    return res.status(400).json({
      success: false,
      error: 'Phone number and user ID are required'
    });
  }

  const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
  if (cleanPhone.length < 8) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid phone number'
    });
  }

  const sessionId = makeid();
  const sessionPath = path.join(__dirname, 'sessions', sessionId);

  // Create session directory
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  console.log(`🔐 Starting pairing for user: ${userId}`);

  try {
    // Use MultiFileAuthState
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    // Prepare options for socket
    const version = await getBaileysVersion();

    const sock = makeWASocket({
      printQRInTerminal: false,
      syncFullHistory: true,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 10000,
      generateHighQualityLinkPreview: true,
      patchMessageBeforeSending: (message) => {
        const requiresPatch = !!(
          message.buttonsMessage ||
          message.templateMessage ||
          message.listMessage
        );
        if (requiresPatch) {
          message = {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadataVersion: 2,
                  deviceListMetadata: {},
                },
                ...message,
              },
            },
          };
        }
        return message;
      },
      version,
      browser: Browsers.ubuntu('Chrome'),
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino().child({ level: 'silent', stream: 'store' })),
      }
    });

    // Store session
    activeSessions.set(sessionId, {
      sock,
      saveCreds,
      sessionPath,
      userId,
      connected: false
    });

    // Listen for creds updates
    sock.ev.on('creds.update', saveCreds);

    // We will request pairing code only once after the socket indicates it is open.
    // Use a one-time listener so repeated /pair calls don't stack handlers.
    let responded = false;

    const onConnectionUpdate = async (update) => {
      try {
        const connection = update?.connection;
        if (!connection) return;

        console.log(`🔗 Connection update: ${connection}`);

        if (connection === 'open') {
          console.log('✅ WA socket opened — now requesting pairing code.');

          try {
            // Request pairing code now that the socket is open.
            const code = await sock.requestPairingCode(cleanPhone.trim());
            console.log(`✅ Pairing code generated: ${code} for user: ${userId}`);

            // Send pairing code back to caller
            if (!responded && !res.headersSent) {
              res.json({
                success: true,
                pairingCode: code,
                sessionId,
                message: 'Enter this code in WhatsApp Linked Devices → Link a Device'
              });
              responded = true;
            }

            // Now wait for actual auth and connection by listening further
            // Notice we don't block the HTTP response; server will continue to listen
            // for connection update -> 'open' (already open) and then 'connection' events for future changes.
          } catch (pairErr) {
            console.error('❌ requestPairingCode error:', pairErr);

            // If requestPairingCode fails, send error if not yet sent
            if (!responded && !res.headersSent) {
              res.status(500).json({
                success: false,
                error: 'Failed to request pairing code: ' + (pairErr?.message || String(pairErr))
              });
              responded = true;
            }

            // Cleanup session on failure
            try { sock.end(); } catch (e) {}
            removeFile(sessionPath);
            activeSessions.delete(sessionId);
          }
        }

        // If the socket closes unexpectedly, notify (but only if response still waiting)
        if (connection === 'close') {
          console.warn('⚠️ Socket connection closed:', update);
          if (!responded && !res.headersSent) {
            res.status(500).json({
              success: false,
              error: 'Socket connection closed before pairing code could be requested'
            });
            responded = true;
          }

          // Cleanup
          try { sock.end(); } catch (e) {}
          removeFile(sessionPath);
          activeSessions.delete(sessionId);
        }
      } catch (e) {
        console.error('❌ Error inside connection.update handler:', e);
      } finally {
        // keep handler attached; we rely on socket lifecycle for further events
      }
    };

    sock.ev.on('connection.update', onConnectionUpdate);

    // Also listen for 'creds.update' already attached; listen for 'connection' final open state to handle post-auth
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        console.log(`🎉 USER ${userId} socket open — monitoring for actual registration...`);
        // Keep monitoring. When device actually registers, Baileys will emit creds update and sock.user will be populated.
      }

      if (connection === 'close') {
        // For informational purpose, log reason
        console.warn('Socket closed:', lastDisconnect?.error || lastDisconnect);
      }
    });

    // As a safety: if socket fails to connect within X ms, reply with error
    setTimeout(() => {
      if (!responded && !res.headersSent) {
        res.status(504).json({
          success: false,
          error: 'Timed out waiting for WhatsApp socket to open. Try again.'
        });
        responded = true;

        try { sock.end(); } catch (e) {}
        removeFile(sessionPath);
        activeSessions.delete(sessionId);
      }
    }, 20000); // 20s timeout to open socket and request pairing code

    // Return early only if sock was created successfully; the pairing code will be returned by the connection.update handler.
    // If the socket creation itself throws, it will be caught by the outer try/catch.
  } catch (err) {
    console.error(`❌ Pairing error for ${userId}:`, err);
    removeFile(sessionPath);
    activeSessions.delete(sessionId);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to generate pairing code. Please try again.'
      });
    }
  }
});

// Status endpoint
app.get('/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (session) {
    res.json({
      success: true,
      connected: session.connected,
      userId: session.userId
    });
  } else {
    res.json({
      success: true,
      connected: false,
      message: 'Session not found'
    });
  }
});

// Graceful shutdown handlers
async function gracefulShutdown() {
  console.log('🧹 Graceful shutdown: closing sockets and cleaning sessions...');
  for (const [id, s] of activeSessions.entries()) {
    try {
      if (s.sock && s.sock.ws && s.sock.ws.readyState !== s.sock.ws.CLOSED) {
        s.sock.ws.close();
      }
    } catch (e) {
      console.warn('Error closing socket for', id, e);
    }
    try {
      if (s.saveCreds) await s.saveCreds();
    } catch (e) {}
    try { removeFile(s.sessionPath); } catch (e) {}
    activeSessions.delete(id);
  }
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

app.listen(port, () => {
  console.log(`🚀 Toxic-MD Pairing API running on port ${port}`);
  console.log(`📱 Pairing endpoint: POST http://localhost:${port}/pair`);
});