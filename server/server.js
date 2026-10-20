// Круг — сервер закрытой соцсети. Без внешних зависимостей: только Node.js 22+.
// Запуск: INVITE_CODE=секрет node server.js
"use strict";
process.removeAllListeners("warning"); // прячем предупреждение об экспериментальном SQLite
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- база ----------
const db = new DatabaseSync(path.join(DATA_DIR, "krug.db"));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, bio TEXT DEFAULT '',
  pass TEXT NOT NULL, is_admin INTEGER DEFAULT 0, created INTEGER NOT NULL, last_seen INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, title TEXT DEFAULT '', about TEXT DEFAULT '', public INTEGER DEFAULT 0,
  owner INTEGER, dm_key TEXT UNIQUE, created INTEGER NOT NULL, last_at INTEGER NOT NULL, last_text TEXT DEFAULT '', last_by INTEGER);
CREATE TABLE IF NOT EXISTS members (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member', last_read INTEGER DEFAULT 0, PRIMARY KEY (chat_id, user_id));
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
  text TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS msg_chat_at ON messages(chat_id, at);
CREATE INDEX IF NOT EXISTS mem_user ON members(user_id);
`);
const q = sql => db.prepare(sql);
const getSetting = k => (q("SELECT value FROM settings WHERE key=?").get(k) || {}).value;
const setSetting = (k, v) => q("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

let INVITE = process.env.INVITE_CODE || getSetting("invite");
if (!INVITE) { INVITE = crypto.randomBytes(4).toString("hex"); }
setSetting("invite", INVITE);

// ---------- утилиты ----------
const now = () => Date.now();
function hashPass(pw) { const salt = crypto.randomBytes(16); const h = crypto.scryptSync(pw, salt, 64); return salt.toString("hex") + ":" + h.toString("hex"); }
function checkPass(pw, stored) {
  const [s, h] = String(stored).split(":"); if (!s || !h) return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, "hex"), 64); const exp = Buffer.from(h, "hex");
  return exp.length === calc.length && crypto.timingSafeEqual(exp, calc);
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const str = (v, max, field) => { if (typeof v !== "string") fail(400, `Поле «${field}» должно быть текстом`); v = v.trim(); if (v.length > max) fail(400, `Поле «${field}» длиннее ${max} символов`); return v; };

// ---------- живые подключения (Server-Sent Events) ----------
const streams = new Map(); // userId -> Set(res)
function push(userIds, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) for (const res of streams.get(id) || []) { try { res.write(payload); } catch {} }
}
const everyone = () => [...streams.keys()];
const isOnline = id => (streams.get(id) || new Set()).size > 0;
setInterval(() => { for (const set of streams.values()) for (const res of set) { try { res.write(": ping\n\n"); } catch {} } }, 25000).unref();

// ---------- представления ----------
function userView(u) { return { id: u.id, username: u.username, name: u.name, bio: u.bio || "", lastSeen: isOnline(u.id) ? now() : u.last_seen, online: isOnline(u.id), isAdmin: !!u.is_admin }; }
function chatView(c, me) {
  const mem = q("SELECT user_id, role, last_read FROM members WHERE chat_id=?").all(c.id);
  const mine = mem.find(m => m.user_id === me);
  const others = mem.filter(m => m.user_id !== me);
  const unread = mine ? q("SELECT COUNT(*) n FROM messages WHERE chat_id=? AND at>? AND user_id<>?").get(c.id, mine.last_read, me).n : 0;
  return {
    id: c.id, type: c.type, title: c.title, about: c.about, public: !!c.public, owner: c.owner,
    createdAt: c.created, lastAt: c.last_at, lastText: c.last_text, lastBy: c.last_by,
    members: mem.map(m => m.user_id), admins: mem.filter(m => m.role === "admin").map(m => m.user_id),
    isMember: !!mine, unread, readBy: others.reduce((a, m) => Math.max(a, m.last_read), 0)
  };
}
const memberIds = chatId => q("SELECT user_id FROM members WHERE chat_id=?").all(chatId).map(r => r.user_id);
const getChat = id => q("SELECT * FROM chats WHERE id=?").get(Number(id)) || fail(404, "Чат не найден");
const roleOf = (chatId, uid) => (q("SELECT role FROM members WHERE chat_id=? AND user_id=?").get(chatId, uid) || {}).role;
function canRead(c, uid) { return c.public || !!roleOf(c.id, uid); }
function notifyChat(c) { const ids = memberIds(c.id); push(c.public ? everyone() : ids, "chat", { chatId: c.id }); }

// ---------- защита от перебора паролей ----------
const attempts = new Map();
function throttle(ip) {
  const a = attempts.get(ip) || { n: 0, t: now() };
  if (now() - a.t > 15 * 60e3) { a.n = 0; a.t = now(); }
  a.n++; attempts.set(ip, a);
  if (a.n > 20) fail(429, "Слишком много попыток. Подождите 15 минут.");
}

// ---------- маршруты ----------
const routes = [];
const route = (method, pattern, auth, fn) => {
  const keys = []; const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, auth, fn });
};

route("GET", "/api/health", false, () => ({ ok: true }));

route("POST", "/api/register", false, ({ body, ip }) => {
  throttle(ip);
  if (str(body.invite || "", 100, "Код приглашения") !== INVITE) fail(403, "Неверный код приглашения");
  const username = str(body.username || "", 24, "Логин").toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) fail(400, "Логин: 3–24 латинские буквы, цифры или _");
  const name = str(body.name || "", 40, "Имя") || username;
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 6) fail(400, "Пароль должен быть не короче 6 символов");
  if (q("SELECT 1 FROM users WHERE username=?").get(username)) fail(409, "Этот логин уже занят");
  const first = q("SELECT COUNT(*) n FROM users").get().n === 0;
  const r = q("INSERT INTO users(username,name,pass,is_admin,created,last_seen) VALUES(?,?,?,?,?,?)").run(username, name, hashPass(password), first ? 1 : 0, now(), now());
  const uid = Number(r.lastInsertRowid);
  // все новички автоматически попадают в общий канал, если он есть
  const general = q("SELECT id FROM chats WHERE type='channel' AND public=1 ORDER BY id LIMIT 1").get();
  if (general) q("INSERT OR IGNORE INTO members(chat_id,user_id,role) VALUES(?,?,?)").run(general.id, uid, first ? "admin" : "member");
  const token = crypto.randomBytes(32).toString("hex");
  q("INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)").run(token, uid, now());
  push(everyone(), "user", { userId: uid });
  return { token };
});

route("POST", "/api/login", false, ({ body, ip }) => {
  throttle(ip);
  const username = String(body.username || "").trim().toLowerCase();
  const u = q("SELECT * FROM users WHERE username=?").get(username);
  if (!u || !checkPass(String(body.password || ""), u.pass)) fail(401, "Неверный логин или пароль");
  const token = crypto.randomBytes(32).toString("hex");
  q("INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)").run(token, u.id, now());
  return { token };
});

route("POST", "/api/logout", true, ({ token }) => { q("DELETE FROM sessions WHERE token=?").run(token); return { ok: true }; });

route("GET", "/api/me", true, ({ me }) => ({ ...userView(me), invite: me.is_admin ? INVITE : undefined }));

route("PATCH", "/api/me", true, ({ me, body }) => {
  const name = body.name != null ? str(body.name, 40, "Имя") : me.name;
  const bio = body.bio != null ? str(body.bio, 120, "О себе") : me.bio;
  if (!name) fail(400, "Имя не может быть пустым");
  q("UPDATE users SET name=?, bio=? WHERE id=?").run(name, bio, me.id);
  if (body.newPassword) {
    if (!checkPass(String(body.oldPassword || ""), me.pass)) fail(403, "Текущий пароль указан неверно");
    if (String(body.newPassword).length < 6) fail(400, "Новый пароль должен быть не короче 6 символов");
    q("UPDATE users SET pass=? WHERE id=?").run(hashPass(String(body.newPassword)), me.id);
  }
  push(everyone(), "user", { userId: me.id });
  return { ok: true };
});

route("POST", "/api/invite", true, ({ me, body }) => {
  if (!me.is_admin) fail(403, "Только администратор сети может менять код приглашения");
  const code = str(body.code || "", 64, "Код");
  if (code.length < 4) fail(400, "Код должен быть не короче 4 символов");
  INVITE = code; setSetting("invite", code); return { invite: code };
});

route("GET", "/api/users", true, () => q("SELECT * FROM users ORDER BY last_seen DESC").all().map(userView));

route("GET", "/api/chats", true, ({ me }) =>
  q("SELECT c.* FROM chats c JOIN members m ON m.chat_id=c.id WHERE m.user_id=? ORDER BY c.last_at DESC").all(me.id).map(c => chatView(c, me.id)));

route("GET", "/api/explore", true, ({ me }) =>
  q("SELECT * FROM chats WHERE public=1 AND type<>'dm' ORDER BY last_at DESC").all().map(c => chatView(c, me.id)));

route("GET", "/api/chats/:id", true, ({ me, params }) => { const c = getChat(params.id); if (!canRead(c, me.id)) fail(404, "Чат не найден"); return chatView(c, me.id); });

route("POST", "/api/chats", true, ({ me, body }) => {
  const type = body.type === "channel" ? "channel" : "group";
  const title = str(body.title || "", 60, "Название"); if (!title) fail(400, "Введите название");
  const about = str(body.about || "", 160, "Описание");
  const t = now();
  const r = q("INSERT INTO chats(type,title,about,public,owner,created,last_at) VALUES(?,?,?,?,?,?,?)").run(type, title, about, body.public ? 1 : 0, me.id, t, t);
  const id = Number(r.lastInsertRowid);
  q("INSERT INTO members(chat_id,user_id,role,last_read) VALUES(?,?,'admin',?)").run(id, me.id, t);
  if (type === "group" && Array.isArray(body.members)) for (const uid of body.members.slice(0, 500))
    if (q("SELECT 1 FROM users WHERE id=?").get(Number(uid))) q("INSERT OR IGNORE INTO members(chat_id,user_id) VALUES(?,?)").run(id, Number(uid));
  const c = getChat(id); notifyChat(c); return chatView(c, me.id);
});

route("POST", "/api/dm/:userId", true, ({ me, params }) => {
  const other = q("SELECT id FROM users WHERE id=?").get(Number(params.userId)) || fail(404, "Пользователь не найден");
  const key = [me.id, other.id].sort((a, b) => a - b).join(":");
  let c = q("SELECT * FROM chats WHERE dm_key=?").get(key);
  if (!c) {
    const t = now();
    const r = q("INSERT INTO chats(type,public,dm_key,created,last_at) VALUES('dm',0,?,?,?)").run(key, t, t);
    const id = Number(r.lastInsertRowid);
    for (const uid of new Set([me.id, other.id])) q("INSERT INTO members(chat_id,user_id,last_read) VALUES(?,?,?)").run(id, uid, t);
    c = getChat(id);
  }
  return chatView(c, me.id);
});

route("PATCH", "/api/chats/:id", true, ({ me, params, body }) => {
  const c = getChat(params.id); if (c.type === "dm" || roleOf(c.id, me.id) !== "admin") fail(403, "Изменять чат могут только его администраторы");
  const title = body.title != null ? str(body.title, 60, "Название") : c.title;
  const about = body.about != null ? str(body.about, 160, "Описание") : c.about;
  const pub = body.public != null ? (body.public ? 1 : 0) : c.public;
  q("UPDATE chats SET title=?, about=?, public=? WHERE id=?").run(title || c.title, about, pub, c.id);
  const n = getChat(c.id); notifyChat(n); if (c.public && !pub) notifyChat(c); return chatView(n, me.id);
});

route("POST", "/api/chats/:id/join", true, ({ me, params }) => {
  const c = getChat(params.id); if (!c.public || c.type === "dm") fail(403, "В этот чат можно попасть только по приглашению");
  q("INSERT OR IGNORE INTO members(chat_id,user_id,last_read) VALUES(?,?,?)").run(c.id, me.id, c.last_at);
  notifyChat(c); return chatView(c, me.id);
});

route("POST", "/api/chats/:id/leave", true, ({ me, params }) => {
  const c = getChat(params.id); if (c.type === "dm") fail(400, "Из личной переписки нельзя выйти");
  const before = memberIds(c.id);
  q("DELETE FROM members WHERE chat_id=? AND user_id=?").run(c.id, me.id);
  // если ушёл последний админ, админом становится самый давний участник
  if (!q("SELECT 1 FROM members WHERE chat_id=? AND role='admin'").get(c.id)) {
    const next = q("SELECT user_id FROM members WHERE chat_id=? ORDER BY rowid LIMIT 1").get(c.id);
    if (next) q("UPDATE members SET role='admin' WHERE chat_id=? AND user_id=?").run(c.id, next.user_id);
  }
  push(c.public ? everyone() : before, "chat", { chatId: c.id }); return { ok: true };
});

route("POST", "/api/chats/:id/members", true, ({ me, params, body }) => {
  const c = getChat(params.id); if (c.type !== "group" || !roleOf(c.id, me.id)) fail(403, "Добавлять людей могут только участники группы");
  const u = q("SELECT id FROM users WHERE id=?").get(Number(body.userId)) || fail(404, "Пользователь не найден");
  q("INSERT OR IGNORE INTO members(chat_id,user_id,last_read) VALUES(?,?,?)").run(c.id, u.id, c.last_at);
  notifyChat(c); return chatView(c, me.id);
});

route("POST", "/api/chats/:id/admins", true, ({ me, params, body }) => {
  const c = getChat(params.id); if (roleOf(c.id, me.id) !== "admin") fail(403, "Назначать админов могут только администраторы");
  const uid = Number(body.userId); if (!roleOf(c.id, uid)) fail(404, "Этот человек не участник чата");
  q("UPDATE members SET role=? WHERE chat_id=? AND user_id=?").run(body.admin ? "admin" : "member", c.id, uid);
  notifyChat(c); return chatView(c, me.id);
});

route("GET", "/api/chats/:id/messages", true, ({ me, params, query }) => {
  const c = getChat(params.id); if (!canRead(c, me.id)) fail(404, "Чат не найден");
  const before = Number(query.get("before")) || 9e15; const limit = Math.min(Number(query.get("limit")) || 60, 200);
  return q("SELECT id, user_id AS 'by', text, at FROM messages WHERE chat_id=? AND at<? ORDER BY at DESC, id DESC LIMIT ?").all(c.id, before, limit).reverse();
});

route("POST", "/api/chats/:id/messages", true, ({ me, params, body }) => {
  const c = getChat(params.id); const role = roleOf(c.id, me.id);
  if (!role) fail(403, "Сначала вступите в чат");
  if (c.type === "channel" && role !== "admin") fail(403, "Публиковать в канале могут только администраторы");
  const text = str(body.text || "", 4000, "Сообщение"); if (!text) fail(400, "Пустое сообщение");
  const at = Math.max(now(), c.last_at + 1);
  const r = q("INSERT INTO messages(chat_id,user_id,text,at) VALUES(?,?,?,?)").run(c.id, me.id, text, at);
  q("UPDATE chats SET last_at=?, last_text=?, last_by=? WHERE id=?").run(at, text.slice(0, 140), me.id, c.id);
  q("UPDATE members SET last_read=? WHERE chat_id=? AND user_id=?").run(at, c.id, me.id);
  const msg = { id: Number(r.lastInsertRowid), by: me.id, text, at };
  const ids = memberIds(c.id);
  push(ids, "message", { chatId: c.id, message: msg });
  push(ids, "chat", { chatId: c.id });
  return msg;
});

route("DELETE", "/api/messages/:id", true, ({ me, params }) => {
  const m = q("SELECT * FROM messages WHERE id=?").get(Number(params.id)) || fail(404, "Сообщение не найдено");
  if (m.user_id !== me.id && roleOf(m.chat_id, me.id) !== "admin") fail(403, "Удалять можно только свои сообщения");
  q("DELETE FROM messages WHERE id=?").run(m.id);
  const last = q("SELECT * FROM messages WHERE chat_id=? ORDER BY at DESC LIMIT 1").get(m.chat_id);
  const c = getChat(m.chat_id);
  if (!last) q("UPDATE chats SET last_text='', last_by=NULL, last_at=? WHERE id=?").run(c.created, c.id);
  else q("UPDATE chats SET last_text=?, last_by=?, last_at=? WHERE id=?").run(last.text.slice(0, 140), last.user_id, last.at, c.id);
  const ids = memberIds(c.id);
  push(c.public ? everyone() : ids, "delete", { chatId: c.id, id: m.id });
  push(c.public ? everyone() : ids, "chat", { chatId: c.id });
  return { ok: true };
});

route("POST", "/api/chats/:id/read", true, ({ me, params }) => {
  const c = getChat(params.id);
  q("UPDATE members SET last_read=MAX(last_read, ?) WHERE chat_id=? AND user_id=?").run(c.last_at, c.id, me.id);
  push(memberIds(c.id), "read", { chatId: c.id, userId: me.id, at: c.last_at });
  return { ok: true };
});

// ---------- HTTP ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname); if (rel === "/" || !path.extname(rel)) rel = "/index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": rel === "/index.html" ? "no-cache" : "public, max-age=3600" });
  fs.createReadStream(file).pipe(res);
}
function authUser(token) {
  if (!token) return null;
  return q("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?").get(token) || null;
}
function send(res, status, data) { const b = JSON.stringify(data); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(b); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";

  // поток событий
  if (url.pathname === "/api/events" && req.method === "GET") {
    const me = authUser(token); if (!me) return send(res, 401, { error: "Войдите заново" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    const wasOnline = isOnline(me.id);
    if (!streams.has(me.id)) streams.set(me.id, new Set());
    streams.get(me.id).add(res);
    if (!wasOnline) push(everyone(), "presence", { userId: me.id, online: true, lastSeen: now() });
    req.on("close", () => {
      const set = streams.get(me.id); if (set) { set.delete(res); if (!set.size) streams.delete(me.id); }
      if (!isOnline(me.id)) { const t = now(); q("UPDATE users SET last_seen=? WHERE id=?").run(t, me.id); push(everyone(), "presence", { userId: me.id, online: false, lastSeen: t }); }
    });
    return;
  }

  const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
  if (!r) return send(res, 404, { error: "Нет такого адреса" });
  try {
    let body = {};
    if (req.method !== "GET") {
      let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) fail(413, "Слишком большой запрос"); }
      if (raw) { try { body = JSON.parse(raw); } catch { fail(400, "Некорректный JSON"); } }
      if (!body || typeof body !== "object") body = {};
    }
    const m = url.pathname.match(r.re); const params = {}; r.keys.forEach((k, i) => params[k] = m[i + 1]);
    let me = null;
    if (r.auth) { me = authUser(token); if (!me) fail(401, "Войдите заново"); }
    const out = r.fn({ req, body, params, query: url.searchParams, me, token, ip });
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { error: e.message });
    else { console.error(e); send(res, 500, { error: "Ошибка сервера" }); }
  }
});

// общий канал создаётся при первом запуске
if (!q("SELECT 1 FROM chats LIMIT 1").get()) {
  const t = now();
  q("INSERT INTO chats(type,title,about,public,created,last_at,last_text) VALUES('channel','Общий','Новости и объявления сети',1,?,?,'')").run(t, t);
}

server.listen(PORT, () => {
  console.log(`Круг запущен: http://localhost:${PORT}`);
  console.log(`Код приглашения: ${INVITE}`);
  console.log(`Данные: ${DATA_DIR}`);
});
