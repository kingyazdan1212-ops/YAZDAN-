const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, "data.json");
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA, "utf8"));
    raw.users = raw.users || {};
    raw.chats = raw.chats || {};
    raw.messages = raw.messages || {};
    raw.sessions = raw.sessions || {};
    return raw;
  } catch {
    return { users: {}, chats: {}, messages: {}, sessions: {} };
  }
}
function save(db) {
  const tmp = DATA + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const next = crypto.scryptSync(String(password), salt, 32);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), next);
  } catch {
    return false;
  }
}
function normalizePhone(p) {
  let s = String(p || "").replace(/[\s-]/g, "");
  s = s.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
  if (s.startsWith("0098")) s = "+98" + s.slice(4);
  if (s.startsWith("098")) s = "+98" + s.slice(3);
  if (s.startsWith("09")) s = "+98" + s.slice(1);
  if (s.startsWith("9") && s.length === 10) s = "+98" + s;
  return s;
}
function validPhone(p) {
  return /^\+[1-9]\d{7,14}$/.test(p);
}
function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length < 120;
}
function validPass(p) {
  return String(p).length >= 8;
}

const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const row = hits.get(key) || [];
  const fresh = row.filter((t) => now - t < windowMs);
  if (fresh.length >= max) return false;
  fresh.push(now);
  hits.set(key, fresh);
  return true;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "0");
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use(express.static(__dirname));

let db = load();
const online = new Map();

function publicUser(u, extra = false) {
  const out = { id: u.id, name: u.name, username: u.username };
  if (extra) {
    out.phone = u.phone;
    out.email = u.email;
  }
  return out;
}
function userByLogin(login) {
  const raw = String(login || "").trim().toLowerCase();
  const phone = normalizePhone(login);
  return Object.values(db.users).find(
    (u) => u.email === raw || u.phone === phone || u.username === raw
  );
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[token] = { userId, exp: Date.now() + TOKEN_TTL_MS };
  save(db);
  return token;
}
function sessionUser(token) {
  const s = db.sessions[token];
  if (!s || s.exp < Date.now() || !db.users[s.userId]) return null;
  return db.users[s.userId];
}

function chatPayload(chat, me) {
  const msgs = db.messages[chat.id] || [];
  const last = msgs[msgs.length - 1];
  const otherId = chat.type === "direct" ? chat.members.find((id) => id !== me) : null;
  const other = otherId ? db.users[otherId] : null;
  const title = chat.type === "direct" ? (other ? other.name : "حذف‌شده") : chat.title;
  const unread = msgs.filter((m) => m.from !== me && !(m.readBy || []).includes(me)).length;
  return {
    id: chat.id,
    type: chat.type,
    title,
    members: chat.members,
    last: last ? last.text : "گفتگو شروع شد",
    time: last ? last.t : chat.createdAt,
    unread,
    online: otherId ? online.has(otherId) : false,
    peerId: otherId || null,
    phone: other ? other.phone : null,
    email: other ? other.email : null
  };
}

app.post("/api/register", (req, res) => {
  const ip = req.ip || "x";
  if (!rateLimit("reg:" + ip, 8, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "تلاش زیاد. کمی بعد دوباره امتحان کن" });
  }
  const { name, username, phone, email, password } = req.body || {};
  const n = String(name || "").trim().slice(0, 40);
  const uname = String(username || "").trim().replace(/\s+/g, "").toLowerCase();
  const em = String(email || "").trim().toLowerCase();
  const ph = normalizePhone(phone);
  if (!n || n.length < 2) return res.status(400).json({ error: "نام معتبر نیست" });
  if (!/^[a-z][a-z0-9_]{2,20}$/.test(uname)) {
    return res.status(400).json({ error: "نام‌کاربری باید انگلیسی، ۳ تا ۲۱ حرف باشد" });
  }
  if (!validPhone(ph)) return res.status(400).json({ error: "شماره موبایل معتبر نیست" });
  if (!validEmail(em)) return res.status(400).json({ error: "ایمیل معتبر نیست" });
  if (!validPass(password)) return res.status(400).json({ error: "رمز حداقل ۸ کاراکتر باشد" });
  const taken = Object.values(db.users).find(
    (u) => u.username === uname || u.email === em || u.phone === ph
  );
  if (taken) return res.status(409).json({ error: "این شماره، ایمیل یا نام‌کاربری قبلاً ثبت شده" });
  const user = {
    id: crypto.randomUUID(),
    name: n,
    username: uname,
    phone: ph,
    email: em,
    password: hashPassword(password),
    contacts: [],
    createdAt: Date.now()
  };
  db.users[user.id] = user;
  const token = createSession(user.id);
  res.json({ token, user: publicUser(user, true) });
});

app.post("/api/login", (req, res) => {
  const ip = req.ip || "x";
  if (!rateLimit("login:" + ip, 12, 10 * 60 * 1000)) {
    return res.status(429).json({ error: "تلاش زیاد. کمی صبر کن" });
  }
  const { login, password } = req.body || {};
  const user = userByLogin(login);
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: "شماره/ایمیل یا رمز اشتباه است" });
  }
  const token = createSession(user.id);
  res.json({ token, user: publicUser(user, true) });
});

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const user = sessionUser(token);
  if (!user) return next(new Error("auth"));
  socket.userId = user.id;
  next();
});

io.on("connection", (socket) => {
  const me = socket.userId;
  online.set(me, socket.id);
  socket.join(me);
  io.emit("presence", { userId: me, online: true });

  const meUser = db.users[me];
  socket.emit("bootstrap", {
    me: publicUser(meUser, true),
    chats: Object.values(db.chats).filter((c) => c.members.includes(me)).map((c) => chatPayload(c, me)),
    contacts: (meUser.contacts || []).map((id) => {
      const u = db.users[id];
      return u ? { ...publicUser(u, true), online: online.has(u.id) } : null;
    }).filter(Boolean)
  });

  socket.on("add_contact", (query, cb) => {
    const q = String(query || "").trim();
    const phone = normalizePhone(q);
    const email = q.toLowerCase();
    const found = Object.values(db.users).find(
      (u) => u.id !== me && (u.phone === phone || u.email === email || u.username === email.replace(/^@/, ""))
    );
    if (!found) return cb({ error: "مخاطب در یزدان ثبت‌نام نکرده" });
    meUser.contacts = meUser.contacts || [];
    if (!meUser.contacts.includes(found.id)) meUser.contacts.push(found.id);
    save(db);
    cb({ contact: { ...publicUser(found, true), online: online.has(found.id) } });
  });

  socket.on("search_users", (q, cb) => {
    const s = String(q || "").trim().toLowerCase();
    const phone = normalizePhone(q);
    const list = Object.values(db.users)
      .filter((u) => u.id !== me && (u.username.includes(s) || u.name.includes(q || "") || u.phone === phone || u.email === s))
      .slice(0, 20)
      .map((u) => ({ ...publicUser(u, true), online: online.has(u.id) }));
    cb(list);
  });

  socket.on("open_direct", (peerId, cb) => {
    if (!db.users[peerId]) return cb({ error: "کاربر نیست" });
    let chat = Object.values(db.chats).find(
      (c) => c.type === "direct" && c.members.includes(me) && c.members.includes(peerId)
    );
    if (!chat) {
      chat = { id: crypto.randomUUID(), type: "direct", members: [me, peerId], createdAt: Date.now() };
      db.chats[chat.id] = chat;
      db.messages[chat.id] = [];
      meUser.contacts = meUser.contacts || [];
      if (!meUser.contacts.includes(peerId)) meUser.contacts.push(peerId);
      save(db);
      const peerSock = online.get(peerId);
      if (peerSock) io.to(peerSock).emit("chat_upsert", chatPayload(chat, peerId));
    }
    cb({ chat: chatPayload(chat, me), messages: db.messages[chat.id] });
  });

  socket.on("create_group", ({ title }, cb) => {
    const t = String(title || "").trim().slice(0, 40);
    if (!t) return cb({ error: "نام گروه لازم است" });
    const chat = {
      id: crypto.randomUUID(),
      type: "group",
      title: t,
      members: [me],
      createdAt: Date.now()
    };
    db.chats[chat.id] = chat;
    db.messages[chat.id] = [
      { id: crypto.randomUUID(), from: me, text: `گروه «${t}» ساخته شد`, t: Date.now(), readBy: [me], system: true }
    ];
    save(db);
    cb({ chat: chatPayload(chat, me), messages: db.messages[chat.id] });
  });

  socket.on("load_messages", (chatId, cb) => {
    const chat = db.chats[chatId];
    if (!chat || !chat.members.includes(me)) return cb({ error: "دسترسی نیست" });
    const msgs = db.messages[chatId] || [];
    msgs.forEach((m) => {
      m.readBy = m.readBy || [];
      if (!m.readBy.includes(me)) m.readBy.push(me);
    });
    save(db);
    chat.members.forEach((id) => {
      const sid = online.get(id);
      if (sid) io.to(sid).emit("chat_upsert", chatPayload(chat, id));
    });
    cb({ messages: msgs });
  });

  socket.on("message", ({ chatId, text }) => {
    const chat = db.chats[chatId];
    const body = String(text || "").trim();
    if (!chat || !chat.members.includes(me) || !body) return;
    const msg = {
      id: crypto.randomUUID(),
      from: me,
      name: db.users[me].name,
      text: body.slice(0, 4000),
      t: Date.now(),
      readBy: [me]
    };
    db.messages[chatId] = db.messages[chatId] || [];
    db.messages[chatId].push(msg);
    save(db);
    chat.members.forEach((id) => {
      io.to(id).emit("message", { chatId, msg });
      const sid = online.get(id);
      if (sid) io.to(sid).emit("chat_upsert", chatPayload(chat, id));
    });
  });

  socket.on("typing", ({ chatId, on }) => {
    const chat = db.chats[chatId];
    if (!chat || !chat.members.includes(me)) return;
    chat.members.forEach((id) => {
      if (id !== me) io.to(id).emit("typing", { chatId, userId: me, name: db.users[me].name, on: !!on });
    });
  });

  socket.on("disconnect", () => {
    if (online.get(me) === socket.id) online.delete(me);
    io.emit("presence", { userId: me, online: false });
  });
});

server.listen(PORT, () => {
  console.log("YAZDAN running on http://localhost:" + PORT);
});
