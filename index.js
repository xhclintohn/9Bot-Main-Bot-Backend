// index.js
// TOXIC-MD – Stable Pairing API
console.clear();
console.log("🚀 Toxic-MD Pairing API Starting...");

const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const cors = require("cors");
const simpleGit = require("simple-git");
const axios = require("axios");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers
} = require("@whiskeysockets/baileys");

// Polyfill fetch
global.fetch = global.fetch || ((...args) =>
    import("node-fetch").then(({ default: fetch }) =>
        fetch(...args)
    )
);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const activeSessions = new Map();

// Generate random ID
function makeid() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array(10).fill().map(() => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// Fetch Baileys version safely
async function getBaileysVersion() {
    try {
        const res = await fetch(
            "https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json"
        );
        const data = await res.json();
        return data.version;
    } catch {
        return [2, 3000, 5]; // fallback
    }
}

app.get("/", (req, res) => {
    res.json({
        status: true,
        api: "Toxic-MD Pairing API",
        message: "Running OK"
    });
});

/* 
========================================================
🔥 MAIN PAIRING ENDPOINT —
========================================================
*/
app.post("/pair", async (req, res) => {
    const { phoneNumber, userId } = req.body;

    if (!phoneNumber || !userId) {
        return res.status(400).json({
            success: false,
            message: "phoneNumber and userId required"
        });
    }

    const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");

    const sessionId = makeid();
    const sessionPath = path.join(__dirname, "sessions", sessionId);
    fs.mkdirSync(sessionPath, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const version = await getBaileysVersion();

        const sock = makeWASocket({
            printQRInTerminal: false,
            browser: Browsers.ubuntu("Chrome"),
            logger: pino({ level: "silent" }),
            syncFullHistory: true,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    pino().child({ level: "silent" })
                ),
            },
            version
        });

        activeSessions.set(sessionId, { sock, saveCreds });

        sock.ev.on("creds.update", saveCreds);

        // EXACT SAME LOGIC AS WORKING SCRIPT:
        // If creds not registered → request pairing code immediately
        if (!state.creds.registered) {
            const code = await sock.requestPairingCode(cleanPhone);

            console.log(`📟 Pairing Code for ${userId}: ${code}`);

            return res.json({
                success: true,
                sessionId,
                pairingCode: code,
                message: "Enter this pairing code in WhatsApp: Linked Devices → Link a Device"
            });
        } else {
            return res.json({
                success: true,
                sessionId,
                message: "Already registered session"
            });
        }

    } catch (err) {
        console.error("Pairing error:", err);

        return res.status(500).json({
            success: false,
            message: "Error generating pairing code",
            error: err?.message
        });
    }
});

// Session status
app.get("/status/:id", (req, res) => {
    const s = activeSessions.get(req.params.id);
    res.json({ exists: !!s });
});

// Start server
app.listen(port, () => {
    console.log(`🟢 API Running on http://localhost:${port}`);
});