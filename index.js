const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

let sessions = {};

app.post("/pair", async (req, res) => {
    try {
        const { phoneNumber, userId } = req.body;
        console.log("Pairing request received:", req.body);

        const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${userId}`);

        // ❗ FIX #1 — Use Baileys internal version fetcher, NOT GitHub URL
        const { version } = await fetchLatestBaileysVersion();

        console.log("🔐 Starting pairing for user:", userId);

        const sock = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: state,
            browser: ["Toxic-MD", "Chrome", "1.0"],
            generateHighQualityLinkPreview: true,
        });

        sessions[userId] = { sock, ready: false, code: null };

        // Pairing code event
        sock.ev.on("connection.update", async (update) => {
            const { connection, pairingCode, lastDisconnect } = update;

            if (pairingCode) {
                sessions[userId].code = pairingCode;
                console.log(`📟 Pairing Code for ${userId}: ${pairingCode}`);
            }

            if (connection === "open") {
                sessions[userId].ready = true;
            }

            if (connection === "close") {
                console.log("Socket closed:", lastDisconnect);
            }
        });

        sock.ev.on("creds.update", saveCreds);

        // Respond immediately to avoid Heroku 504 timeout
        return res.json({
            status: "pairing_started",
            message: "Wait for pairing code",
            userId
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Pairing failed" });
    }
});

// Return current status
app.get("/status/:id", (req, res) => {
    const id = req.params.id;
    if (!sessions[id]) return res.json({ status: "not_found" });

    return res.json({
        ready: sessions[id].ready,
        code: sessions[id].code || null
    });
});

app.listen(process.env.PORT || 3000, () => {
    console.log("🚀 Toxic-MD Pairing API Running...");
});