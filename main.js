// Scalechat Desktop — proceso principal (Electron + Baileys)
//
// Qué hace: conecta uno o varios números de WhatsApp por QR usando Baileys, pero
// corriendo en la PC del usuario (su IP residencial → SIN proxy). Cuando llega un
// mensaje, lo manda a Scalechat (/api/desktop/inbound), que ejecuta el MISMO
// motor de flujos (flujos, IA, comprobantes) y devuelve la lista de acciones;
// esta app las envía por WhatsApp con sus tiempos. La sesión se guarda en el disco
// del usuario, así que no re-escanea el QR al reabrir.
//
// NO tiene lógica de negocio: es solo el "cable" a WhatsApp. Todo se configura en
// la web de Scalechat.

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const QRCode = require("qrcode");
const pino = require("pino");

// Baileys se distribuye como ESM: en la app EMPAQUETADA, require() de un ESM falla
// con ERR_REQUIRE_ESM. Por eso lo cargamos con import() DINÁMICO (que sí funciona
// desde CommonJS) al arrancar, antes de conectar ningún número.
let makeWASocket;
let useMultiFileAuthState;
let fetchLatestBaileysVersion;
let DisconnectReason;
let Browsers;
let downloadMediaMessage;
let baileysLoading = null;

async function loadBaileys() {
  if (makeWASocket) return; // ya cargado
  if (!baileysLoading) {
    baileysLoading = import("@whiskeysockets/baileys").then((b) => {
      makeWASocket = b.default;
      useMultiFileAuthState = b.useMultiFileAuthState;
      fetchLatestBaileysVersion = b.fetchLatestBaileysVersion;
      DisconnectReason = b.DisconnectReason;
      Browsers = b.Browsers;
      downloadMediaMessage = b.downloadMediaMessage;
    });
  }
  await baileysLoading;
}

const logger = pino({ level: "silent" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Estado en memoria ───────────────────────────────────────────────────────
let mainWindow = null;
let profiles = []; // [{ id, name, apiUrl, token }]
const sockets = new Map(); // id -> WASocket
const runtime = new Map(); // id -> { status, phone, qr, lastError }
const reconnectTimers = new Map();
const reconnectAttempts = new Map(); // id -> nº de reintentos seguidos (para backoff)
// Guarda los mensajes SALIENTES por id: si el destinatario no descifra y pide un
// "retry receipt", Baileys llama a getMessage y reenviamos desde aquí. CLAVE para
// que los 1:1 se ENTREGUEN (si no, quedan en "Esperando este mensaje…").
const sentStore = new Map(); // waMessageId -> message
function rememberSent(sent) {
  const id = sent && sent.key && sent.key.id;
  if (id && sent.message) {
    sentStore.set(id, sent.message);
    if (sentStore.size > 300) sentStore.delete(sentStore.keys().next().value);
  }
}

// ── Rutas de datos (persisten entre reinicios) ──────────────────────────────
function userDir() {
  return app.getPath("userData");
}
function configPath() {
  return path.join(userDir(), "config.json");
}
function sessionDir(id) {
  return path.join(userDir(), "sessions", id);
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const j = JSON.parse(raw);
    profiles = Array.isArray(j.profiles) ? j.profiles : [];
  } catch {
    profiles = [];
  }
}
function saveConfig() {
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ profiles }, null, 2));
  } catch (e) {
    log("No se pudo guardar la configuración: " + e.message);
  }
}

// ── Comunicación con la ventana (UI) ────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  mainWindow?.webContents.send("log", line);
}
function setRuntime(id, patch) {
  runtime.set(id, { ...(runtime.get(id) || {}), ...patch });
  pushState();
}
function pushState() {
  const list = profiles.map((p) => ({
    ...p,
    ...(runtime.get(p.id) || { status: "DISCONNECTED" }),
  }));
  mainWindow?.webContents.send("state", list);
}

// ── API de Scalechat ────────────────────────────────────────────────────────
function apiBase(profile) {
  return (profile.apiUrl || "").replace(/\/+$/, "");
}
async function postStatus(profile, body) {
  try {
    await fetch(`${apiBase(profile)}/api/desktop/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${profile.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    log(`[${profile.name}] no se pudo reportar estado: ${e.message}`);
  }
}
async function postInbound(profile, payload) {
  try {
    const res = await fetch(`${apiBase(profile)}/api/desktop/inbound`, {
      method: "POST",
      headers: { authorization: `Bearer ${profile.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log(`[${profile.name}] inbound respondió ${res.status} (¿token válido? ¿URL correcta?)`);
      return { actions: [] };
    }
    return await res.json();
  } catch (e) {
    log(`[${profile.name}] error llamando a Scalechat: ${e.message}`);
    return { actions: [] };
  }
}

// ── Extraer el contenido de un mensaje entrante ─────────────────────────────
function extractInbound(msg) {
  const m = msg.message;
  if (!m) return null;
  if (m.conversation) return { type: "text", text: m.conversation };
  if (m.extendedTextMessage?.text) return { type: "text", text: m.extendedTextMessage.text };
  if (m.imageMessage) return { type: "image", text: m.imageMessage.caption || "", mime: m.imageMessage.mimetype };
  if (m.videoMessage) return { type: "video", text: m.videoMessage.caption || "" };
  if (m.audioMessage) return { type: "audio", text: "" };
  if (m.documentMessage) return { type: "document", text: m.documentMessage.caption || "" };
  return { type: "text", text: "" };
}

// ── Ejecutar las acciones que devuelve Scalechat ────────────────────────────
async function executeActions(sock, jid, actions) {
  for (const a of actions || []) {
    try {
      if (a.type === "typing") {
        await sock.sendPresenceUpdate("composing", jid);
        await sleep(Math.min(Math.max(Number(a.seconds) || 0, 0), 20) * 1000);
        await sock.sendPresenceUpdate("paused", jid);
      } else if (a.type === "text") {
        if (a.body) rememberSent(await sock.sendMessage(jid, { text: a.body }));
      } else if (a.type === "media") {
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`no se pudo descargar el medio (${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        const cap = a.caption || undefined;
        let sent;
        if (a.kind === "image") sent = await sock.sendMessage(jid, { image: buf, caption: cap });
        else if (a.kind === "video") sent = await sock.sendMessage(jid, { video: buf, caption: cap });
        else if (a.kind === "audio") sent = await sock.sendMessage(jid, { audio: buf, mimetype: "audio/mp4", ptt: true });
        else if (a.kind === "document")
          sent = await sock.sendMessage(jid, { document: buf, fileName: a.filename || "archivo", caption: cap });
        rememberSent(sent);
      }
    } catch (e) {
      log(`Error enviando una acción (${a.type}): ${e.message}`);
    }
  }
}

// ── Conexión de un perfil (número) ──────────────────────────────────────────
// Programa un reintento de conexión con backoff (2.5s → tope 30s). NUNCA muere:
// cada intento fallido vuelve a programar el siguiente. Es la ÚNICA vía de reintento
// para que un número caído siempre vuelva solo (antes, si el reintento fallaba, el
// número quedaba muerto hasta reconectar a mano).
function scheduleReconnect(profile, delayMs) {
  if (reconnectTimers.has(profile.id)) return; // ya hay uno en cola
  let delay = delayMs;
  if (delay == null) {
    const n = (reconnectAttempts.get(profile.id) || 0) + 1;
    reconnectAttempts.set(profile.id, n);
    delay = Math.min(2500 * Math.pow(1.6, n - 1), 30000);
  }
  log(`[${profile.name}] reintento en ${Math.round(delay / 1000)}s…`);
  const t = setTimeout(() => {
    reconnectTimers.delete(profile.id);
    if (profiles.find((p) => p.id === profile.id)) {
      startProfile(profile).catch(() => {}); // startProfile maneja y reprograma sus errores
    }
  }, delay);
  reconnectTimers.set(profile.id, t);
}

async function startProfile(profile) {
  if (sockets.has(profile.id)) return; // ya conectado/conectando
  try {
    await loadBaileys(); // Baileys (ESM) debe estar cargado antes de usarlo
    const dir = sessionDir(profile.id);
    fs.mkdirSync(dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    // La versión es un "nice to have": si la red falla al consultarla, seguimos con
    // la versión embebida de Baileys en vez de tirar todo el arranque (esto tumbaba
    // la reconexión).
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {}

    setRuntime(profile.id, { status: "CONNECTING", lastError: null });
    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: Browsers.appropriate("Scalechat"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Reenvía el contenido cuando el destinatario pide un retry (retry receipt).
      // Necesario para que los 1:1 se ENTREGUEN (si no, "Esperando este mensaje…").
      getMessage: async (key) => sentStore.get((key && key.id) || "") || undefined,
    });
    sockets.set(profile.id, sock);

    sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
      setRuntime(profile.id, { status: "QR_PENDING", qr: dataUrl });
      await postStatus(profile, { status: "QR_PENDING", qr: dataUrl });
      log(`[${profile.name}] escanea el QR con WhatsApp del teléfono.`);
    }

    if (connection === "open") {
      const phone = (sock.user?.id || "").split(":")[0].split("@")[0];
      reconnectAttempts.delete(profile.id); // conexión OK: reinicia el backoff
      setRuntime(profile.id, { status: "CONNECTED", qr: null, phone, lastError: null });
      await postStatus(profile, { status: "CONNECTED", phoneNumber: phone, qr: null, lastError: null });
      log(`[${profile.name}] CONECTADO (${phone}).`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      sockets.delete(profile.id);
      const loggedOut = code === DisconnectReason.loggedOut;
      if (loggedOut) {
        // Sesión cerrada desde el teléfono: limpiamos credenciales y pedimos QR nuevo.
        reconnectAttempts.delete(profile.id);
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
        setRuntime(profile.id, { status: "DISCONNECTED", qr: null, phone: null, lastError: "Sesión cerrada desde el teléfono" });
        await postStatus(profile, { status: "DISCONNECTED", lastError: "Sesión cerrada desde el teléfono", phoneNumber: null, qr: null });
        log(`[${profile.name}] desconectado (logout). Vuelve a añadirlo para escanear.`);
      } else {
        // Caída transitoria: reconectamos (sin re-escanear) con backoff que nunca muere.
        setRuntime(profile.id, { status: "CONNECTING", lastError: `Reconectando… (código ${code ?? "?"})` });
        await postStatus(profile, { status: "CONNECTING", lastError: `Reconectando… (${code ?? "?"})` });
        log(`[${profile.name}] conexión caída (código ${code ?? "?"}), reintentando…`);
        scheduleReconnect(profile);
      }
    }
  });

  // Mensajes entrantes → motor de flujos de Scalechat → ejecutar respuesta.
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const remoteJid = msg.key.remoteJid || "";
        // Solo 1:1: ignoramos grupos y estados.
        if (remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast" || remoteJid.endsWith("@broadcast")) continue;

        const content = extractInbound(msg);
        if (!content) continue;

        // @lid = identificador ANÓNIMO de WhatsApp (no es el teléfono). El teléfono
        // real viene en senderPn. Usamos el jid de teléfono para (a) mostrar el
        // número correcto y (b) RESPONDER: WhatsApp entrega mejor al teléfono que
        // al @lid (el @lid a veces "acepta" el envío pero no lo reparte).
        const senderPn = msg.key.senderPn || "";
        const replyJid = remoteJid.endsWith("@lid") && senderPn ? senderPn : remoteJid;
        const from = replyJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        if (!from) continue;

        let imageBase64, imageMediaType;
        if (content.type === "image") {
          try {
            const buf = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
            imageBase64 = buf.toString("base64");
            imageMediaType = content.mime || "image/jpeg";
          } catch (e) {
            log(`[${profile.name}] no se pudo descargar la imagen: ${e.message}`);
          }
        }

        const name = msg.pushName || null;
        log(`[${profile.name}] ← ${from}: ${content.text || "(" + content.type + ")"}`);

        const { actions } = await postInbound(profile, {
          from,
          name,
          text: content.text,
          type: content.type,
          imageBase64,
          imageMediaType,
          waMessageId: msg.key.id,
          timestamp: Number(msg.messageTimestamp) || undefined,
        });

        if (actions?.length) {
          log(`[${profile.name}] → enviando ${actions.length} acción(es)`);
          await executeActions(sock, replyJid, actions);
        }
      } catch (e) {
        log(`[${profile.name}] error procesando mensaje: ${e.message}`);
      }
    }
  });
  } catch (e) {
    // Falla al ARRANCAR (red al pedir versión, auth, etc.): antes esto tumbaba el
    // reintento y el número quedaba muerto. Ahora reprogramamos siempre.
    sockets.delete(profile.id);
    setRuntime(profile.id, { status: "CONNECTING", lastError: `Reintentando… (${e.message})` });
    log(`[${profile.name}] error al iniciar: ${e.message}; reintentando…`);
    scheduleReconnect(profile);
  }
}

function stopProfile(id) {
  clearTimeout(reconnectTimers.get(id));
  reconnectTimers.delete(id);
  reconnectAttempts.delete(id);
  const sock = sockets.get(id);
  try {
    sock?.end(undefined);
  } catch {}
  sockets.delete(id);
  runtime.delete(id);
}

// ── IPC (la ventana pide/edita perfiles) ────────────────────────────────────
ipcMain.handle("profiles:list", () =>
  profiles.map((p) => ({ ...p, ...(runtime.get(p.id) || { status: "DISCONNECTED" }) })),
);
ipcMain.handle("profiles:add", async (_e, data) => {
  const name = String(data?.name || "").trim();
  const apiUrl = String(data?.apiUrl || "").trim();
  const token = String(data?.token || "").trim();
  if (name.length < 2) return { error: "Ponle un nombre." };
  if (!/^https?:\/\//.test(apiUrl)) return { error: "La URL de Scalechat debe empezar con http(s)://" };
  if (token.length < 10) return { error: "Pega el token del dispositivo (lo obtienes en Scalechat → Canales)." };
  const id = "p_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const profile = { id, name, apiUrl, token };
  profiles.push(profile);
  saveConfig();
  pushState();
  startProfile(profile).catch((e) => log(`No se pudo iniciar: ${e.message}`));
  return { ok: true, id };
});
ipcMain.handle("profiles:remove", async (_e, id) => {
  stopProfile(id);
  try {
    fs.rmSync(sessionDir(id), { recursive: true, force: true });
  } catch {}
  profiles = profiles.filter((p) => p.id !== id);
  saveConfig();
  pushState();
  return { ok: true };
});
ipcMain.handle("profiles:reconnect", async (_e, id) => {
  const p = profiles.find((x) => x.id === id);
  if (p) {
    // Fuerza: corta lo que haya (socket colgado o reintento en cola) y reintenta ya.
    clearTimeout(reconnectTimers.get(id));
    reconnectTimers.delete(id);
    reconnectAttempts.delete(id);
    const s = sockets.get(id);
    try {
      s?.end(undefined);
    } catch {}
    sockets.delete(id);
    startProfile(p).catch(() => {});
  }
  return { ok: true };
});

// ── Arranque de la app ──────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: "Scalechat Desktop",
    backgroundColor: "#0b0b12",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.on("did-finish-load", () => pushState());
}

// Auto-actualización: al abrir la app (solo empaquetada), busca una versión nueva
// publicada en GitHub Releases, la descarga y la instala al reiniciar. Así los
// usuarios reciben mejoras sin reinstalar a mano.
function setupAutoUpdate() {
  if (!app.isPackaged) return; // en desarrollo no se actualiza
  try {
    // Carga perezosa: electron-updater se instancia contra el 'app' de Electron
    // (por eso solo se requiere aquí, ya con la app lista y empaquetada).
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.on("checking-for-update", () => log("Buscando actualizaciones…"));
    autoUpdater.on("update-available", (i) => log(`Actualización disponible: ${i?.version ?? ""}`));
    autoUpdater.on("update-not-available", () => log("La app está al día."));
    autoUpdater.on("download-progress", (p) => log(`Descargando actualización: ${Math.round(p.percent)}%`));
    autoUpdater.on("update-downloaded", () => log("Actualización lista: se instalará al reiniciar la app."));
    autoUpdater.on("error", (e) => log(`Auto-update: ${e?.message ?? e}`));
    autoUpdater.checkForUpdatesAndNotify();
  } catch (e) {
    log(`No se pudo iniciar la auto-actualización: ${e.message}`);
  }
}

app.whenReady().then(() => {
  loadConfig();
  createWindow();
  setupAutoUpdate();
  // Reanuda todas las sesiones guardadas.
  for (const p of profiles) startProfile(p).catch((e) => log(`No se pudo reanudar ${p.name}: ${e.message}`));

  // Vigilante (watchdog): cada 45s revisa que cada número que DEBERÍA estar
  // conectado lo esté. Si alguno quedó caído sin socket ni reintento en cola (p. ej.
  // un fallo raro que se escapó del backoff), lo levanta. Es la red de seguridad
  // final para que NUNCA haya que reconectar a mano.
  setInterval(() => {
    for (const p of profiles) {
      const st = runtime.get(p.id)?.status;
      if (st === "CONNECTED" || st === "QR_PENDING") continue;
      if (sockets.has(p.id) || reconnectTimers.has(p.id)) continue;
      log(`[${p.name}] vigilante: sin conexión, reintentando…`);
      scheduleReconnect(p, 1000);
    }
  }, 45000);

  // Al reanudar la PC (salir de suspensión) o desbloquear la pantalla, los sockets
  // suelen estar muertos: forzamos una revisión inmediata para reconectar rápido.
  try {
    const { powerMonitor } = require("electron");
    const wake = () => {
      log("PC reanudada: revisando conexiones…");
      for (const p of profiles) {
        if (!sockets.has(p.id) && !reconnectTimers.has(p.id)) scheduleReconnect(p, 1000);
      }
    };
    powerMonitor.on("resume", wake);
    powerMonitor.on("unlock-screen", wake);
  } catch {}

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Mantener corriendo en segundo plano: en Windows/Linux no cerramos al cerrar la
// ventana si hay perfiles activos (el bot debe seguir respondiendo).
app.on("window-all-closed", () => {
  // Cerramos del todo solo si el usuario sale con Cmd/Ctrl+Q (app.quit()).
  if (process.platform !== "darwin") {
    // No hacemos app.quit() aquí para no matar las sesiones; la app queda viva.
    // El usuario cierra desde la bandeja/tarea si quiere. (Bandeja del sistema: Fase 4.)
  }
});
