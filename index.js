const express = require('express');
const { Pool } = require('pg');
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, fetchLatestWaWebVersion } = require("@whiskeysockets/baileys");
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
    console.log('✅ Database initialized');
  } catch (error) {
    console.error('❌ Database init error:', error);
  }
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

    // Validate phone number format
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    if (!cleanPhone.startsWith('254')) {
      return res.status(400).json({
        success: false,
        error: 'Phone number must start with 62 (Indonesia)'
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

    const sessionId = `toxic_${userId}_${Date.now()}`;
    const sessionPath = path.join(__dirname, 'sessions', sessionId);

    // Create session directory
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    console.log(`🔐 Creating session for user ${userId}`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const { version } = await fetchLatestWaWebVersion();
    
    const sock = makeWASocket({
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino().child({ level: 'silent' })),
      },
      version,
      browser: Browsers.ubuntu('Chrome'),
      logger: pino({ level: 'silent' })
    });

    // Request pairing code
    console.log(`📱 Requesting pairing code for: ${cleanPhone}`);
    const code = await sock.requestPairingCode(cleanPhone);
    console.log(`✅ Pairing code generated: ${code} for user: ${userId}`);
    
    // Store session info
    activePairingSessions.set(sessionId, {
      sock,
      saveCreds,
      state,
      sessionPath,
      userId,
      phoneNumber: cleanPhone,
      connected: false,
      pairingCode: code
    });

    // Save user to database
    await pool.query(
      'INSERT INTO users (user_id, phone_number, session_id, status) VALUES ($1, $2, $3, $4)',
      [userId, cleanPhone, sessionId, 'pairing']
    );

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const session = activePairingSessions.get(sessionId);
      if (!session) return;

      console.log(`🔗 Connection update for ${userId}:`, update.connection);

      if (update.connection === 'open') {
        console.log(`✅ User ${userId} connected successfully!`);
        session.connected = true;
        
        // Update database
        await pool.query(
          'UPDATE users SET status = $1, connected_at = $2 WHERE user_id = $3',
          ['connected', new Date(), userId]
        );

        // Trigger deployment
        await deployToHeroku(sessionId, userId);
      }

      if (update.connection === 'close') {
        console.log(`❌ Connection closed for user ${userId}`);
        await pool.query(
          'UPDATE users SET status = $1 WHERE user_id = $2',
          ['disconnected', userId]
        );
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Cleanup session after 10 minutes if not connected
    setTimeout(() => {
      const session = activePairingSessions.get(sessionId);
      if (session && !session.connected) {
        console.log(`🕒 Session expired for user ${userId}`);
        activePairingSessions.delete(sessionId);
        // Clean up session files
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
      }
    }, 10 * 60 * 1000);

    res.json({ 
      success: true, 
      pairingCode: code,
      sessionId,
      message: 'Enter this code in WhatsApp Linked Devices → Link a Device'
    });

  } catch (error) {
    console.error('❌ Pairing error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to generate pairing code: ' + error.message 
    });
  }
});

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

    // Create Heroku app
    const createAppResponse = await axios.post(
      'https://api.heroku.com/apps',
      { name: appName },
      {
        headers: {
          'Authorization': `Bearer ${HEROKU_API_KEY}`,
          'Accept': 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
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
        }
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
        }
      }
    );

    // Update database with deployment info
    await pool.query(
      'UPDATE users SET heroku_app = $1, deployed_at = $2, status = $3 WHERE user_id = $4',
      [appName, new Date(), 'deployed', userId]
    );

    console.log(`✅ Bot deployed successfully for user ${userId}: ${appName}`);

    // Cleanup session after successful deployment
    setTimeout(() => {
      if (activePairingSessions.has(sessionId)) {
        activePairingSessions.delete(sessionId);
      }
      // Optional: Clean up session files
      if (fs.existsSync(session.sessionPath)) {
        fs.rmSync(session.sessionPath, { recursive: true, force: true });
      }
    }, 30000); // Cleanup after 30 seconds

  } catch (error) {
    console.error('❌ Heroku deployment error:', error.response?.data || error.message);
    
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
    if (session) {
      user.session_active = true;
      user.pairing_code = session.pairingCode;
    } else {
      user.session_active = false;
    }

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