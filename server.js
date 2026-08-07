/**
 * Servidor Baileys — Backend del dashboard WhatsApp Masivo
 * Conexión WhatsApp por QR/número (sin Meta Cloud API)
 *
 * Deploy en Railway.app o Render.com:
 *   1. Subí server.js y package.json a un repo de GitHub
 *   2. Conectá el repo en Railway o Render (tipo: Web Service)
 *   3. Build: npm install  ·  Start: npm start
 *   4. Copiá la URL pública y pegala en el dashboard → Configuración
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
  status: "disconnected",
  phone: null,
  qr: null,
  pairingCode: null,
};

// === ALMACENAMIENTO DE CONTACTOS EN MEMORIA + PERSISTENCIA EN DISCO ===
const contactsMap = new Map();
const CONTACTS_FILE = path.join(__dirname, "contacts.json");

function loadContacts() {
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf-8"));
      for (const [id, c] of Object.entries(data)) {
        contactsMap.set(id, c);
      }
      console.log("[CONTACTS] Cargados", contactsMap.size, "contactos guardados");
    }
  } catch (e) {
    console.error("[CONTACTS] Error cargando:", e.message);
  }
}

function saveContacts() {
  try {
    const obj = {};
    for (const [id, c] of contactsMap.entries()) obj[id] = c;
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("[CONTACTS] Error guardando:", e.message);
  }
}

function upsertContact(id, data) {
  if (!id) return;
  const existing = contactsMap.get(id) || {};
  contactsMap.set(id, { ...existing, ...data, id });
}

loadContacts();

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

  // Guardar contactos a disco cada 30s
  setInterval(saveContacts, 30000);

  // === CAPTURA DE CONTACTOS DESDE MÚLTIPLES EVENTOS ===
  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      upsertContact(c.id, {
        name: c.notify || c.name || (c.id ? c.id.split("@")[0] : ""),
        isGroup: c.id ? c.id.includes("@g.us") : false,
      });
    }
    saveContacts();
  });

  sock.ev.on("contacts.update", (updates) => {
    for (const u of updates) {
      upsertContact(u.id, {
        name: u.notify || u.name || (u.id ? u.id.split("@")[0] : ""),
        isGroup: u.id ? u.id.includes("@g.us") : false,
      });
    }
  });

  // Capturar contactos desde los chats abiertos
  sock.ev.on("chats.upsert", (chats) => {
    for (const c of chats) {
      if (c.id && !c.id.includes("@g.us")) {
        upsertContact(c.id, {
          name: c.name || c.id.split("@")[0],
          isGroup: false,
        });
      }
    }
  });

  // Capturar desde mensajes entrantes/salientes
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) {
      const jid = m.key?.remoteJid;
      if (jid && !jid.includes("@g.us")) {
        upsertContact(jid, {
          name: m.pushName || jid.split("@")[0],
          isGroup: false,
        });
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, disconnected } = update;

    if (qr) {
      try {
        const dataUri = await QRCode.toDataURL(qr, { width: 300 });
        connectionState.qr = dataUri;
        connectionState.status = "qr";
        console.log("[QR] Código generado");
      } catch (err) {
        console.error("[QR] Error:", err.message);
      }
    }

    if (connection === "connecting") {
      connectionState.status = "connecting";
    }

    if (connection === "open") {
      connectionState.status = "connected";
      connectionState.qr = null;
      connectionState.pairingCode = null;
      connectionState.phone = sock.user ? sock.user.id.split(":")[0] : null;
      console.log("[CONN] Conectado como", connectionState.phone);
      saveContacts();
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
        contactsMap.clear();
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }
    }
  });

  return sock;
}

startSock().catch((err) => console.error("Error iniciando:", err));

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
    res.json({ qr: null, status: connectionState.status });
  }
});

app.post("/reconnect", async (req, res) => {
  try {
    if (sock) { try { sock.end(); } catch (e) {} }
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
    res.json({ ok: true, pairingCode });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === LISTAR CONTACTOS (individuales + grupos) ===
app.get("/contacts", async (req, res) => {
  try {
    if (!sock || connectionState.status !== "connected") {
      return res.status(503).json({ ok: false, error: "WhatsApp no conectado" });
    }

    // Contactos individuales desde contactsMap (capturados por eventos)
    const seen = new Set();
    const individualContacts = Array.from(contactsMap.values())
      .filter((c) => {
        if (!c.id || !c.id.includes("@s.whatsapp.net") || seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      })
      .map((c) => ({
        id: c.id,
        name: c.name || c.id.split("@")[0],
        phone: c.id.split("@")[0],
        isGroup: false,
        avatar: null,
      }));

    // Grupos
    const groups = (await sock.groupFetchAllParticipating?.()) || {};
    const groupContacts = Object.values(groups).map((g) => ({
      id: g.id,
      name: g.subject || "Grupo sin nombre",
      phone: "",
      isGroup: true,
      avatar: null,
    }));

    const allContacts = [...individualContacts, ...groupContacts];
    console.log("[CONTACTS]", individualContacts.length, "individuales +", groupContacts.length, "grupos");
    res.json(allContacts);
  } catch (err) {
    console.error("[CONTACTS] Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/labels", async (req, res) => {
  res.json([]);
});

app.post("/send", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ ok: false, error: "Faltan to o message" });
    if (!sock || connectionState.status !== "connected") {
      return res.status(503).json({ ok: false, error: "WhatsApp no conectado" });
    }
    let jid = to;
    if (!jid.includes("@")) jid = jid.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    const result = await sock.sendMessage(jid, { text: message });
    res.json({ ok: true, messageId: result?.key?.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/send-image", async (req, res) => {
  try {
    const { to, imageUrl, caption } = req.body;
    if (!to || !imageUrl) return res.status(400).json({ ok: false, error: "Faltan to o imageUrl" });
    if (!sock || connectionState.status !== "connected") {
      return res.status(503).json({ ok: false, error: "WhatsApp no conectado" });
    }
    let jid = to;
    if (!jid.includes("@")) jid = jid.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    const result = await sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption || "" });
    res.json({ ok: true, messageId: result?.key?.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/logout", async (req, res) => {
  try {
    if (sock) await sock.logout();
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    contactsMap.clear();
    try { fs.unlinkSync(CONTACTS_FILE); } catch (e) {}
    connectionState = { status: "disconnected", phone: null, qr: null, pairingCode: null };
    res.json({ ok: true, message: "Sesión cerrada" });
    setTimeout(() => startSock(), 1000);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Servidor Baileys en puerto " + PORT);
});
