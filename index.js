const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const axios = require('axios');
const cors = require('cors');
const simpleGit = require('simple-git');

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
function removeFile(path) {
  if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true });
}

function makeid() {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 10; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
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

// Routes
app.get('/', (req, res) => {
  res.json({ 
    status: 'Toxic-MD Pairing API', 
    version: '1.0',
    message: 'Server is running!'
  });
});

// Pairing endpoint 
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
    
    // Create socket
    const sock = makeWASocket({
      printQRInTerminal: false, // Changed from friend's !usePairingCode
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
      // Use dynamic version
      version: (await (await fetch('https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json')).json()).version,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      logger: pino({
        level: 'fatal'
      }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino().child({
          level: 'silent',
          stream: 'store'
        })),
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

    // === Pairing Code Generation - EXACT SAME AS FRIEND'S CODE ===
    if (!sock.authState.creds.registered) {
      console.log(`📱 Requesting pairing code for: ${cleanPhone}`);
      
      // Request pairing code immediately - same as friend's code
      const code = await sock.requestPairingCode(cleanPhone.trim());
      console.log(`✅ Pairing code generated: ${code} for user: ${userId}`);
      
      // Send response immediately
      res.json({ 
        success: true, 
        pairingCode: code,
        sessionId: sessionId,
        message: 'Enter this code in WhatsApp Linked Devices → Link a Device'
      });

      // Wait for connection like friend's code does
      console.log(`⏳ Waiting for user ${userId} to connect...`);
      
      return new Promise((resolve) => {
        sock.ev.on('connection.update', async (update) => {
          const { connection } = update;
          console.log(`🔗 Connection update: ${connection}`);
          
          if (connection === 'open') {
            console.log(`🎉 USER ${userId} SUCCESSFULLY CONNECTED!`);
            
            const session = activeSessions.get(sessionId);
            if (session) session.connected = true;

            try {
              // Send welcome message
              await sock.sendMessage(sock.user.id, {
                text: `
◈━━━━━━━━━━━━━━━━◈
│❒ Hello! 👋 You're now connected to Toxic-MD.

│❒ Saving your session and deploying bot...
│❒ Please wait a moment! 🙂
◈━━━━━━━━━━━━━━━━◈
                `
              });

              // Save to GitHub and deploy
              console.log(`💾 Starting GitHub save for ${userId}...`);
              await saveToGitHubAndDeploy(sessionPath, userId, cleanPhone);
              
              // Send success message
              await sock.sendMessage(sock.user.id, {
                text: `
◈━━━━━━━━━━━━━━━━◈
│❒ SUCCESS! 🎉

│❒ Your Toxic-MD bot has been deployed!
│❒ It should be ready in a few minutes.
│❒ Thank you for using Toxic-MD! 🚀
◈━━━━━━━━━━━━━━━━◈
                `
              });
              
              console.log(`✅ All done for user ${userId}!`);
              
            } catch (deployError) {
              console.error(`❌ Deployment failed for ${userId}:`, deployError);
              await sock.sendMessage(sock.user.id, {
                text: '❌ Deployment failed. Please try again later.'
              });
            }

            // Close connection
            if (sock.ws && sock.ws.readyState !== sock.ws.CLOSED) {
              sock.ws.close();
            }
            
            // Cleanup
            setTimeout(() => {
              removeFile(sessionPath);
              activeSessions.delete(sessionId);
            }, 10000);

            resolve();
          }
        });
      });
    }

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

// Start server
app.listen(port, () => {
  console.log(`🚀 Toxic-MD Pairing API running on port ${port}`);
  console.log(`📱 Pairing endpoint: POST http://localhost:${port}/pair`);
});