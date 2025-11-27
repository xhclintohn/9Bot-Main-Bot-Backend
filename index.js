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

// Store active pairing sessions
const activePairingSessions = new Map();

// Initialize database
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) UNIQUE NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        session_id VARCHAR(255) NOT NULL,
        heroku_app VARCHAR(255),
        connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deployed_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'pending'
      )
    `);
    
    // Check if pairing_code column exists, if not add it
    try {
      await pool.query('SELECT pairing_code FROM users LIMIT 1');
    } catch (error) {
      if (error.code === '42703') { // column doesn't exist
        console.log('📊 Adding pairing_code column to users table...');
        await pool.query('ALTER TABLE users ADD COLUMN pairing_code VARCHAR(10)');
        console.log('✅ pairing_code column added successfully');
      } else {
        throw error;
      }
    }
    
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

// Routes

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Toxic-MD Pairing API', 
    version: '1.0',
    message: 'Server is running!',
    endpoints: [
      'POST /pair - Start pairing',
      'GET /status/:userId - Check status',
      'GET /sessions - List all sessions'
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

    // Validate phone number format - allow all country codes
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
      'INSERT INTO users (user_id, phone_number, session_id, status) VALUES ($1, $2, $3, $4)',
      [userId, cleanPhone, sessionId, 'pairing']
    );

    // Start pairing process
    startPairingProcess(userId, cleanPhone, sessionId, sessionPath, res);

  } catch (error) {
    console.error('❌ Pairing setup error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to setup pairing process. Please try again later.' 
    });
  }
});

// Pairing process function
async function startPairingProcess(userId, phoneNumber, sessionId, sessionPath, res) {
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
    activePairingSessions.set(sessionId, {
      sock,
      saveCreds,
      state,
      sessionPath,
      userId,
      phoneNumber,
      connected: false,
      pairingCode: null,
      waitingForPairing: true
    });

    // === Pairing Code Generation ===
    if (!sock.authState.creds.registered) {
      await delay(1500); // Wait for socket to initialize
      
      console.log(`📱 Requesting pairing code for: ${phoneNumber}`);
      const code = await sock.requestPairingCode(phoneNumber);
      console.log(`✅ Pairing code generated: ${code} for user: ${userId}`);
      
      // Update session with pairing code
      const session = activePairingSessions.get(sessionId);
      session.pairingCode = code;
      session.waitingForPairing = true;

      try {
        // Try to update with pairing_code column
        await pool.query(
          'UPDATE users SET pairing_code = $1, status = $2 WHERE user_id = $3',
          [code, 'waiting_for_pairing', userId]
        );
      } catch (dbError) {
        if (dbError.code === '42703') {
          // If pairing_code column doesn't exist, update without it
          console.log('⚠️ pairing_code column not found, updating status only');
          await pool.query(
            'UPDATE users SET status = $1 WHERE user_id = $2',
            ['waiting_for_pairing', userId]
          );
        } else {
          throw dbError;
        }
      }

      // Send response to client
      if (!res.headersSent) {
        res.json({ 
          success: true, 
          pairingCode: code,
          sessionId,
          message: 'Enter this code in WhatsApp Linked Devices → Link a Device'
        });
      }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const session = activePairingSessions.get(sessionId);
      if (!session) return;

      const { connection, lastDisconnect } = update;
      
      console.log(`🔗 Connection update for ${userId}:`, connection);

      if (connection === 'connecting') {
        console.log(`🔄 Connecting to WhatsApp for ${userId}`);
        await pool.query(
          'UPDATE users SET status = $1 WHERE user_id = $2',
          ['connecting', userId]
        );
      }
      
      if (connection === 'open') {
        console.log(`🎉 USER ${userId} SUCCESSFULLY PAIRED AND CONNECTED!`);
        session.connected = true;
        session.waitingForPairing = false;
        
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

        await delay(3000);

        // Trigger deployment
        await deployToHeroku(sessionId, userId);
      }

      if (connection === 'close') {
        console.log(`🔌 Connection closed for user ${userId}`);
        
        // Only mark as disconnected if we were previously connected
        if (session.connected) {
          await pool.query(
            'UPDATE users SET status = $1 WHERE user_id = $2',
            ['disconnected', userId]
          );
        } else if (session.waitingForPairing) {
          // This is normal - the initial connection for code generation closes
          console.log(`ℹ️ Initial connection closed for pairing code generation - waiting for user to pair...`);
          await pool.query(
            'UPDATE users SET status = $1 WHERE user_id = $2',
            ['waiting_for_user', userId]
          );
        }
      }
    });

    // Cleanup session after 30 minutes if not connected
    setTimeout(() => {
      const session = activePairingSessions.get(sessionId);
      if (session && !session.connected) {
        console.log(`🕒 Session expired for user ${userId}`);
        activePairingSessions.delete(sessionId);
        removeFile(sessionPath);
        
        pool.query(
          'UPDATE users SET status = $1 WHERE user_id = $2',
          ['expired', userId]
        ).catch(console.error);
      }
    }, 30 * 60 * 1000);

  } catch (error) {
    console.error('❌ Pairing process error:', error);
    
    // Clean up session files
    removeFile(sessionPath);
    activePairingSessions.delete(sessionId);
    
    // Update database
    await pool.query(
      'UPDATE users SET status = $1 WHERE user_id = $2',
      ['failed', userId]
    );
    
    // Send error response if not already sent
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false,
        error: 'Failed to generate pairing code. Please try again.' 
      });
    }
  }
}

// Deploy to Heroku
async function deployToHeroku(sessionId, userId) {
  try {
    const session = activePairingSessions.get(sessionId);
    if (!session) {
      console.log(`❌ Session not found for deployment: ${sessionId}`);
      return;
    }

    const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
    if (!HEROKU_API_KEY) {
      console.error('❌ HEROKU_API_KEY not found in environment variables');
      await pool.query(
        'UPDATE users SET status = $1 WHERE user_id = $2',
        ['deployment_failed', userId]
      );
      return;
    }

    console.log(`🚀 Starting deployment for user: ${userId}`);

    // Update status to deploying
    await pool.query(
      'UPDATE users SET status = $1 WHERE user_id = $2',
      ['deploying', userId]
    );

    const appName = `toxic-md-${userId}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, 30);

    console.log(`🔧 Creating Heroku app: ${appName}`);

    try {
      // Create Heroku app
      const createAppResponse = await axios.post(
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
          USER_ID: userId,
          SESSION_ID: sessionId
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

      // Build from GitHub (using your Toxic-MD repo)
      const buildResponse = await axios.post(
        `https://api.heroku.com/apps/${appName}/builds`,
        {
          source_blob: {
            url: 'https://github.com/xhclintohn/Toxic-v2/tarball/main/'
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

      // Update database with deployment info
      await pool.query(
        'UPDATE users SET heroku_app = $1, deployed_at = $2, status = $3 WHERE user_id = $4',
        [appName, new Date(), 'deployed', userId]
      );

      console.log(`✅ Bot deployed successfully for user ${userId}: ${appName}`);

      // Send success message
      try {
        const session = activePairingSessions.get(sessionId);
        if (session && session.sock) {
          await session.sock.sendMessage(session.sock.user.id, {
            text: `
◈━━━━━━━━━━━━━━━━◈
│❒ Deployment Successful! 🎉

│❒ Your Toxic-MD bot is now live!
│❒ Heroku App: ${appName}
│❒ Bot is ready to use! 🚀
◈━━━━━━━━━━━━━━━━◈
            `
          });
        }
      } catch (msgError) {
        console.log('⚠️ Could not send deployment message:', msgError.message);
      }

    } catch (herokuError) {
      console.error('❌ Heroku API error:', herokuError.response?.data || herokuError.message);
      throw herokuError;
    }

    // Cleanup session after successful deployment
    setTimeout(() => {
      if (activePairingSessions.has(sessionId)) {
        activePairingSessions.delete(sessionId);
      }
      // Optional: Clean up session files after deployment
      setTimeout(() => {
        if (session && fs.existsSync(session.sessionPath)) {
          removeFile(session.sessionPath);
        }
      }, 60000);
    }, 30000);

  } catch (error) {
    console.error('❌ Heroku deployment error:', error.message);
    
    // Update status to failed
    await pool.query(
      'UPDATE users SET status = $1 WHERE user_id = $2',
      ['deployment_failed', userId]
    );
  }
}

// Check deployment status
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
    
    // Check if session is still active
    const session = activePairingSessions.get(user.session_id);
    
    let userStatus = user.status;
    let pairingStatus = 'waiting';
    
    if (session) {
      user.session_active = true;
      user.pairing_code = session.pairingCode;
      user.connected = session.connected;
      
      if (session.connected) {
        pairingStatus = 'connected';
      } else if (session.waitingForPairing) {
        pairingStatus = 'waiting_for_user';
      }
    } else {
      user.session_active = false;
      user.connected = false;
      
      // Check database status for more accurate info
      if (user.status === 'waiting_for_user' || user.status === 'waiting_for_pairing') {
        pairingStatus = 'waiting_for_user';
      } else if (user.status === 'connected' || user.status === 'deploying' || user.status === 'deployed') {
        pairingStatus = 'completed';
      }
    }

    res.json({ 
      success: true,
      user: {
        ...user,
        pairing_status: pairingStatus,
        display_status: getDisplayStatus(user.status, pairingStatus)
      }
    });

  } catch (error) {
    console.error('❌ Status check error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get status' 
    });
  }
});

// Helper function for better status display
function getDisplayStatus(dbStatus, pairingStatus) {
  const statusMap = {
    'waiting_for_user': '⏳ Waiting for you to enter the pairing code in WhatsApp',
    'waiting_for_pairing': '⏳ Waiting for pairing',
    'connecting': '🔄 Connecting to WhatsApp...',
    'connected': '✅ Paired successfully! Deploying bot...',
    'deploying': '🚀 Deploying to Heroku...',
    'deployed': '🎉 Bot deployed and ready!',
    'failed': '❌ Failed - please try again',
    'expired': '⏰ Pairing code expired'
  };
  
  return statusMap[pairingStatus] || statusMap[dbStatus] || dbStatus;
}

// List all sessions
app.get('/sessions', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT user_id, phone_number, heroku_app, status, connected_at, deployed_at FROM users ORDER BY connected_at DESC LIMIT 50'
    );
    
    res.json({ 
      success: true,
      total: result.rows.length,
      sessions: result.rows 
    });
  } catch (error) {
    console.error('❌ Sessions list error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get sessions' 
    });
  }
});

// Get active pairing sessions (admin endpoint)
app.get('/admin/sessions', (req, res) => {
  const activeSessions = Array.from(activePairingSessions.entries()).map(([sessionId, session]) => ({
    sessionId,
    userId: session.userId,
    phoneNumber: session.phoneNumber,
    connected: session.connected,
    pairingCode: session.pairingCode
  }));

  res.json({
    success: true,
    activeSessions: activeSessions,
    totalActive: activeSessions.length
  });
});

// Cleanup endpoint (optional)
app.delete('/cleanup', async (req, res) => {
  try {
    // Clean up old sessions from database
    const result = await pool.query(
      'DELETE FROM users WHERE connected_at < NOW() - INTERVAL \'7 days\' AND status != \'deployed\''
    );
    
    res.json({
      success: true,
      message: `Cleaned up ${result.rowCount} old sessions`
    });
  } catch (error) {
    console.error('❌ Cleanup error:', error);
    res.status(500).json({
      success: false,
      error: 'Cleanup failed'
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('🚨 Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
app.listen(port, async () => {
  await initializeDatabase();
  console.log(`🚀 Toxic-MD Pairing API running on port ${port}`);
  console.log(`🔗 Health check: http://localhost:${port}/`);
  console.log(`📱 Pairing endpoint: POST http://localhost:${port}/pair`);
});