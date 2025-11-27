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
        status VARCHAR(50) DEFAULT 'pending',
        connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

// Routes

// Health check
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

    // Validate phone number format
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
      pairingCode: null
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

│❒ Your session has been saved successfully!
│❒ You can now close this window. 🙂
◈━━━━━━━━━━━━━━━━◈
            `
          });

          await delay(3000);

          // Send session file as base64
          const credsPath = path.join(sessionPath, 'creds.json');
          if (fs.existsSync(credsPath)) {
            const data = fs.readFileSync(credsPath);
            const base64 = Buffer.from(data).toString('base64');
            
            await sock.sendMessage(sock.user.id, { 
              text: `Your Session Credentials (Base64):\n\n${base64}\n\nSave this for future use!` 
            });
          }

        } catch (msgError) {
          console.log('⚠️ Could not send welcome message:', msgError.message);
        }

        // Close connection after sending messages
        await delay(5000);
        sock.ws.close();
        
        // Cleanup after delay
        setTimeout(() => {
          removeFile(sessionPath);
          activePairingSessions.delete(sessionId);
        }, 10000);
      }

      if (connection === 'close') {
        console.log(`🔌 Connection closed for user ${userId}`);
        
        if (!session.connected) {
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
    
    let pairingStatus = 'waiting';
    
    if (session) {
      user.session_active = true;
      user.pairing_code = session.pairingCode;
      user.connected = session.connected;
      
      if (session.connected) {
        pairingStatus = 'connected';
      } else {
        pairingStatus = 'waiting_for_user';
      }
    } else {
      user.session_active = false;
      user.connected = false;
      
      // Check database status
      if (user.status === 'waiting_for_user') {
        pairingStatus = 'waiting_for_user';
      } else if (user.status === 'connected') {
        pairingStatus = 'completed';
      }
    }

    res.json({ 
      success: true,
      user: {
        ...user,
        pairing_status: pairingStatus
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

// Start server
app.listen(port, async () => {
  await initializeDatabase();
  console.log(`🚀 Toxic-MD Pairing API running on port ${port}`);
  console.log(`🔗 Health check: http://localhost:${port}/`);
  console.log(`📱 Pairing endpoint: POST http://localhost:${port}/pair`);
});