const express = require('express');
const { Pool } = require('pg');
const {
  default: Toxic_Tech,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const simpleGit = require('simple-git');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Environment variables
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const GITHUB_REPO = 'https://github.com/thebitnomad/9bot.git';

// Store active pairing sessions
const activePairingSessions = new Map();
const tempDir = path.join(__dirname, 'temp-repo');

// Initialize database
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) UNIQUE NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        heroku_app VARCHAR(255),
        connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deployed_at TIMESTAMP
      )
    `);
    console.log('✅ Database initialized');
  } catch (error) {
    console.error('❌ Database init error:', error);
  }
}

// Helper function to remove files
function removeFile(path) {
  if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true });
}

// Generate random ID
function makeid() {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 10; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// Clone GitHub repo
async function cloneRepo() {
  try {
    const git = simpleGit();
    const repoUrl = `https://${GITHUB_TOKEN}@github.com/thebitnomad/9bot.git`;
    
    if (fs.existsSync(tempDir)) {
      removeFile(tempDir);
    }
    
    await git.clone(repoUrl, tempDir);
    console.log('✅ GitHub repo cloned successfully');
    return simpleGit(tempDir);
  } catch (error) {
    console.error('❌ Failed to clone repo:', error);
    throw error;
  }
}

// Save credentials to GitHub and deploy
async function saveCredsAndDeploy(sessionPath, userId, phoneNumber) {
  try {
    console.log(`🚀 Starting deployment process for user: ${userId}`);
    
    // Clone the repo
    const git = await cloneRepo();
    
    // Copy session files to repo Session folder
    const repoSessionPath = path.join(tempDir, 'Session');
    if (!fs.existsSync(repoSessionPath)) {
      fs.mkdirSync(repoSessionPath, { recursive: true });
    }
    
    // Copy all session files
    const sessionFiles = fs.readdirSync(sessionPath);
    for (const file of sessionFiles) {
      const sourcePath = path.join(sessionPath, file);
      const destPath = path.join(repoSessionPath, file);
      fs.copyFileSync(sourcePath, destPath);
    }
    
    console.log(`✅ Session files copied to repo for user: ${userId}`);
    
    // Commit and push to GitHub
    await git.add('.');
    await git.commit(`Add session for user ${userId}`);
    await git.push('origin', 'main');
    
    console.log(`✅ Session pushed to GitHub for user: ${userId}`);
    
    // Update database
    await pool.query(
      'UPDATE users SET status = $1 WHERE user_id = $2',
      ['deploying', userId]
    );
    
    // Deploy to Heroku
    await deployToHeroku(userId);
    
  } catch (error) {
    console.error('❌ Save and deploy error:', error);
    await pool.query(
      'UPDATE users SET status = $1 WHERE user_id = $2',
      ['deployment_failed', userId]
    );
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

    // Configure environment variables
    await axios.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      {
        USER_ID: userId
      },
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

    // Update database
    await pool.query(
      'UPDATE users SET heroku_app = $1, deployed_at = $2, status = $3 WHERE user_id = $4',
      [appName, new Date(), 'deployed', userId]
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
    message: 'Server is running!',
    endpoints: [
      'POST /pair - Start pairing',
      'GET /status/:userId - Check status'
    ]
  });
});

// Start pairing process
app.post('/pair', async (req, res) => {
  console.log('📞 Pairing request received:', req.body);
  
  try {
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

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE user_id = $1',
      [userId]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ 
        success: false,
        error: 'User ID already exists. Please choose a different one.' 
      });
    }

    const sessionId = `toxic_${userId}_${makeid()}`;
    const sessionPath = path.join(__dirname, 'sessions', sessionId);

    // Create session directory
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    console.log(`🔐 Creating session for user ${userId}`);

    // Save user to database
    await pool.query(
      'INSERT INTO users (user_id, phone_number, status) VALUES ($1, $2, $3)',
      [userId, cleanPhone, 'pairing']
    );

    // Start pairing process
    startPairingProcess(userId, cleanPhone, sessionPath, res);

  } catch (error) {
    console.error('❌ Pairing setup error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to setup pairing process. Please try again later.' 
    });
  }
});

// Pairing process function
async function startPairingProcess(userId, phoneNumber, sessionPath, res) {
  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = Toxic_Tech({
      version,
      logger: pino({ level: 'fatal' }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
      },
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
    });

    // Store session info
    activePairingSessions.set(userId, {
      sock,
      saveCreds,
      sessionPath,
      connected: false
    });

    // === Pairing Code Generation ===
    if (!sock.authState.creds.registered) {
      await delay(1500);
      
      console.log(`📱 Requesting pairing code for: ${phoneNumber}`);
      const code = await sock.requestPairingCode(phoneNumber);
      console.log(`✅ Pairing code generated: ${code} for user: ${userId}`);

      // Update database
      await pool.query(
        'UPDATE users SET status = $1 WHERE user_id = $2',
        ['waiting_for_user', userId]
      );

      // Send response to client
      if (!res.headersSent) {
        res.json({ 
          success: true, 
          pairingCode: code,
          message: 'Enter this code in WhatsApp Linked Devices → Link a Device'
        });
      }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const session = activePairingSessions.get(userId);
      if (!session) return;

      const { connection } = update;
      
      console.log(`🔗 Connection update for ${userId}:`, connection);

      if (connection === 'open') {
        console.log(`🎉 USER ${userId} SUCCESSFULLY PAIRED AND CONNECTED!`);
        session.connected = true;
        
        // Update database
        await pool.query(
          'UPDATE users SET status = $1, connected_at = $2 WHERE user_id = $3',
          ['connected', new Date(), userId]
        );

        // Send welcome message
        try {
          await sock.sendMessage(sock.user.id, {
            text: `
◈━━━━━━━━━━━━━━━━◈
│❒ Hello! 👋 You're now connected to Toxic-MD.

│❒ Your bot is being deployed to Heroku...
│❒ Please wait a moment while we set up everything! 🙂
◈━━━━━━━━━━━━━━━━◈
            `
          });
        } catch (msgError) {
          console.log('⚠️ Could not send welcome message:', msgError.message);
        }

        // Save credentials to GitHub and deploy
        await saveCredsAndDeploy(sessionPath, userId, phoneNumber);

        // Close connection
        await delay(5000);
        sock.ws.close();
        
        // Cleanup
        setTimeout(() => {
          removeFile(sessionPath);
          activePairingSessions.delete(userId);
        }, 10000);
      }

      if (connection === 'close') {
        console.log(`🔌 Connection closed for user ${userId}`);
      }
    });

    // Cleanup session after 30 minutes if not connected
    setTimeout(() => {
      const session = activePairingSessions.get(userId);
      if (session && !session.connected) {
        console.log(`🕒 Session expired for user ${userId}`);
        activePairingSessions.delete(userId);
        removeFile(sessionPath);
        
        pool.query(
          'UPDATE users SET status = $1 WHERE user_id = $2',
          ['expired', userId]
        ).catch(console.error);
      }
    }, 30 * 60 * 1000);

  } catch (error) {
    console.error('❌ Pairing process error:', error);
    
    removeFile(sessionPath);
    activePairingSessions.delete(userId);
    
    await pool.query(
      'UPDATE users SET status = $1 WHERE user_id = $2',
      ['failed', userId]
    );
    
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false,
        error: 'Failed to generate pairing code. Please try again.' 
      });
    }
  }
}

// Check status
app.get('/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM users WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    const user = result.rows[0];
    
    res.json({ 
      success: true,
      user: user
    });

  } catch (error) {
    console.error('❌ Status check error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get status' 
    });
  }
});

// Start server
app.listen(port, async () => {
  await initializeDatabase();
  console.log(`🚀 Toxic-MD Pairing API running on port ${port}`);
});