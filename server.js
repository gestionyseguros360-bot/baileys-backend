/**
 * Servidor Baileys — Backend del dashboard WhatsApp Masivo
 *
 * Deploy en Railway.app o Render.com:
 *   1. Subí esta carpeta a un repo de GitHub
 *   2. Conectá el repo en Railway o Render (tipo: Web Service)
 *   3. Build command: npm install
 *   4. Start command: npm start
 *   5. Copiá la URL pública y pegala en el dashboard → Configuración
 *
 * Endpoints:
 *   GET  /status         → { status, phone, qr }
 *   GET  /qr             → { qr }  (QR como data URI base64)
 *   POST /connect-phone  → { phone } → { pairingCode }
 *   GET  /contacts       → [{ id, name, phone, isGroup, avatar }]
 *   GET  /labels         → [{ id, name, color }]
 *   POST /send           → { to, message } → { success, messageId }
 *   POST /send-image     → { to, imageUrl, caption } → { success, messageId }
 *   POST /logout         → cierra sesión
 */

const express = require("express");
const cors = require("cors");
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  default: makeWASocket,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const logger = pino({ level: "silent" });

let sock = null;
let connectionState = {
  status: "disconnected", // disconnected | qr | connecting | connected
  phone: null,
  qr: null,
  pairingCode: null,
};

const AUTH_DIR = path.join(__dirname, "auth_state");
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ["WhatsApp Masivo", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, disconnected } = update;

    if (qr) {
      try {
        const dataUri = await QRCode.toDataURL(qr, { width: 300 });
        connectionState.qr = dataUri;
        connectionState.status = "qr";
        console.log("[QR] Código generado — esperando escaneo");
      } catch (err) {
        console.error("[QR] Error generando QR:", err.message);
      }
    }

    if (connection === "connecting") {
      connectionState.status = "connecting";
      console.log("[CONN] Conectando...");
    }

    if (connection === "open") {
      connectionState.status = "connected";
      connectionState.qr = null;
      connectionState.pairingCode = null;
      const user = sock.user;
      connectionState.phone = user ? user.id.split(":")[0] : null;
      console.log("[CONN] Conectado como", connectionState.phone);
    }

    if (connection === "close") {
      const shouldReconnect = disconnected !== DisconnectReason.loggedOut;
      console.log("[CONN] Cerrada. Reason:", disconnected, "Reconnect:", shouldReconnect);
      if (shouldReconnect) {
        connectionState.status = "connecting";
        startSock();
      } else {
        connectionState.status = "disconnected";
        connectionState.qr = null;
        connectionState.phone = null;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }
    }
  });

  return sock;
}

startSock().catch((err) => console.error("Error iniciando socket:", err));

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.json({ ok: true, service: "whatsapp-baileys", status: connectionState.status });
});

app.get("/status", (req, res) => {
  res.json({
    status: connectionState.status,
    phone: connectionState.phone,
    qr: connectionState.status === "qr" ? connectionState.qr : null,
  });
});

app.get("/qr", (req, res) => {
  if (connectionState.qr) {
    res.json({ qr: connectionState.qr, status: connectionState.status });
  } else {
    res.json({ qr: null, status: connectionState.status, message: "No hay QR disponible. Reconectá." });
  }
});

app.post("/reconnect", async (req, res) => {
  try {
    if (sock) {
      try { sock.end(); } catch (e) {}
    }
    connectionState.qr = null;
    connectionState.status = "connecting";
    await startSock();
    res.json({ ok: true, message: "Reconectando..." });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/connect-phone", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ ok: false, error: "Falta phone" });

    if (!sock || connectionState.status === "disconnected") {
      await startSock();
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    const cleanPhone = phone.replace(/[^0-9]/g, "");
    const pairingCode = await sock.requestPairingCode(cleanPhone);
    connectionState.pairingCode = pairingCode;
    connectionState.status = "connecting";
    console.log("[PAIR] Código generado para", cleanPhone, ":", pairingCode);
    res.json({ ok: true, pairingCode });
  } catch (err) {
    console.error("[PAIR] Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/contacts", async (req, res) => {
  try {
    if (!sock || connectionState.status !== "connected") {
      return res.status(503).json({ ok: false, error: "WhatsApp no conectado" });
    }

    const contacts = (await sock.getAllContacts?.()) || [];
    const groups = (await sock.groupFetchAllParticipating?.()) || {};

    const allContacts = [
      ...contacts.map((c) => ({
        id: c.id,
        name: c.notify || c.name || c.id.split("@")[0],
        phone: c.id.includes("@s.whatsapp.net") ? c.id.split("@")[0] : "",
        isGroup: false,
        avatar: null,
      })),
      ...Object.values(groups).map((g) => ({
        id: g.id,
        name: g.subject || "Grupo sin nombre",
        phone: "",
        isGroup: true,
        avatar: null,
      })),
    ];

    res.json(allContacts);
  } catch (err) {
    console.error("[CONTACTS] Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/labels", async (req, res) => {
  try {
    if (!sock || connectionState.status !== "connected") {
      return res.status(503).json({ ok: false, error: "WhatsApp no conectado" });
    }
    res.json([]);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/send", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) {
      return res.status(400).json({ ok: false, error: "Faltan to o message" });
    }
    if (!sock || connectionState.status !== "connected") {
      return res.status(503).json({ ok: false, error: "WhatsApp no conectado" });
    }

    let jid = to;
    if (!jid.includes("@")) {
      jid = jid.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    }

    const result = await sock.sendMessage(jid, { text: message });
    res.json({ ok: true, messageId: result?.key?.id });
  } catch (err) {
    console.error("[SEND] Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/send-image", async (req, res) => {
  try {
    const { to, imageUrl, caption } = req.body;
    if (!to || !imageUrl) {
      return res.status(400).json({ ok: false, error: "Faltan to o imageUrl" });
    }
    if (!sock || connectionState.status !== "connected") {
      return res.status(503).json({ ok: false, error: "WhatsApp no conectado" });
    }

    let jid = to;
    if (!jid.includes("@")) {
      jid = jid.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    }

    const result = await sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || "",
    });
    res.json({ ok: true, messageId: result?.key?.id });
  } catch (err) {
    console.error("[SEND-IMAGE] Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/logout", async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    connectionState = { status: "disconnected", phone: null, qr: null, pairingCode: null };
    res.json({ ok: true, message: "Sesión cerrada" });
    setTimeout(() => startSock(), 1000);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Baileys corriendo en puerto ${PORT}`);
});
