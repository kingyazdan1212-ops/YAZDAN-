const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const COLORS = ["#e17076","#faa774","#a695e7","#7bc862","#6ec9cb","#65aadd","#ee7aae","#2aabee"];
const colorFor = (name) => COLORS[Math.abs([...(name||"?")].reduce((a,c)=>a+c.charCodeAt(0),0)) % COLORS.length];
const initials = (name) => (name||"؟").split(" ").slice(0,2).map(p=>p[0]).join("");

const state = {
  token: localStorage.getItem("yazdan_token"),
  me: JSON.parse(localStorage.getItem("yazdan_me") || "null"),
  chats: [],
  messages: {},
  activeId: null,
  folder: "all",
  query: "",
  socket: null
};

function fmtTime(t) {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("fa-IR", { month: "short", day: "numeric" });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "خطا");
  return data;
}

function renderAuth() {
  $("#app").innerHTML = `
    <section class="auth">
      <div class="auth-card">
        <div class="logo-mark">Y</div>
        <h1>YAZDAN</h1>
        <p>ثبت‌نام با شماره و ایمیل. بعد به مخاطبین پیام بفرست.</p>
        <input id="name" placeholder="نام نمایشی">
        <input id="username" placeholder="نام‌کاربری انگلیسی">
        <input id="phone" placeholder="شماره موبایل مثلاً ۰۹۱۲۳۴۵۶۷۸۹" inputmode="tel">
        <input id="email" placeholder="ایمیل" type="email">
        <input id="password" type="password" placeholder="رمز حداقل ۸ کاراکتر">
        <input id="loginId" placeholder="ورود با شماره یا ایمیل یا نام‌کاربری">
        <button class="btn" id="register">ساخت حساب</button>
        <button class="btn" id="login" style="margin-top:8px;background:#243140">ورود</button>
        <div class="auth-hint" id="err">رمز روی سرور با scrypt هش می‌شود.</div>
      </div>
    </section>`;
  const err = (e) => { $("#err").textContent = e.message; };
  $("#register").onclick = async () => {
    try {
      const data = await api("/api/register", {
        name: $("#name").value,
        username: $("#username").value,
        phone: $("#phone").value,
        email: $("#email").value,
        password: $("#password").value
      });
      enter(data);
    } catch (e) { err(e); }
  };
  $("#login").onclick = async () => {
    try {
      const data = await api("/api/login", {
        login: $("#loginId").value || $("#email").value || $("#phone").value || $("#username").value,
        password: $("#password").value
      });
      enter(data);
    } catch (e) { err(e); }
  };
}

function enter(data) {
  state.token = data.token;
  state.me = data.user;
  localStorage.setItem("yazdan_token", data.token);
  localStorage.setItem("yazdan_me", JSON.stringify(data.user));
  connect();
}

function connect() {
  $("#app").innerHTML = `<section class="auth"><div class="auth-card"><h1>در حال اتصال…</h1></div></section>`;
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;
  socket.on("connect_error", () => {
    localStorage.removeItem("yazdan_token");
    localStorage.removeItem("yazdan_me");
    state.token = null;
    renderAuth();
  });
  socket.on("bootstrap", ({ me, chats }) => {
    state.me = me;
    state.chats = chats;
    renderApp();
  });
  socket.on("chat_upsert", (chat) => {
    const i = state.chats.findIndex(c => c.id === chat.id);
    if (i >= 0) state.chats[i] = chat; else state.chats.unshift(chat);
    renderList();
    if (state.activeId === chat.id) {
      const st = $("#status");
      if (st) st.textContent = statusText(chat);
    }
  });
  socket.on("message", ({ chatId, msg }) => {
    state.messages[chatId] = state.messages[chatId] || [];
    if (!state.messages[chatId].some(m => m.id === msg.id)) state.messages[chatId].push(msg);
    if (state.activeId === chatId) renderMessages();
  });
  socket.on("presence", ({ userId, online }) => {
    state.chats.forEach(c => { if (c.peerId === userId) c.online = online; });
    renderList();
    if (state.activeId) {
      const c = state.chats.find(x => x.id === state.activeId);
      if (c && c.peerId === userId) {
        const st = $("#status");
        if (st) st.textContent = statusText(c);
      }
    }
  });
  socket.on("typing", ({ chatId, name, on }) => {
    if (state.activeId === chatId) {
      const st = $("#status");
      const chat = state.chats.find(c=>c.id===chatId);
      if (st) st.textContent = on ? name + " در حال نوشتن..." : statusText(chat);
    }
  });
}

function statusText(chat) {
  if (!chat) return "";
  if (chat.type === "group") return "گروه · " + chat.members.length + " عضو";
  return chat.online ? "آنلاین" : "آفلاین";
}

function filteredChats() {
  return state.chats.filter(c => {
    if (state.folder === "users" && c.type !== "direct") return false;
    if (state.folder === "groups" && c.type !== "group") return false;
    if (state.query && !c.title.includes(state.query)) return false;
    return true;
  }).sort((a,b) => (b.time||0) - (a.time||0));
}

function renderApp() {
  const active = state.chats.find(c => c.id === state.activeId);
  $("#app").innerHTML = `
    <aside class="sidebar ${active && innerWidth<=820 ? "hide-mobile":""}">
      <div class="side-head">
        <button class="icon-btn" id="menuBtn">☰</button>
        <div class="search"><input id="q" placeholder="جستجوی گفتگو" value="${escapeHtml(state.query)}"></div>
      </div>
      <div class="folders">
        <button class="folder ${state.folder==="all"?"active":""}" data-f="all">همه</button>
        <button class="folder ${state.folder==="users"?"active":""}" data-f="users">شخصی</button>
        <button class="folder ${state.folder==="groups"?"active":""}" data-f="groups">گروه‌ها</button>
      </div>
      <div class="chat-list" id="list"></div>
    </aside>
    <section class="main ${active?"":"empty-state"}" id="main"></section>
    <aside class="profile" id="profile"></aside>
    <div class="drawer" id="drawer">
      <div class="drawer-panel">
        <div class="me">
          <div class="avatar" style="background:${colorFor(state.me.name)}">${initials(state.me.name)}</div>
          <div>
            <div class="name">${escapeHtml(state.me.name)}</div>
            <div style="color:var(--text-secondary);font-size:13px">@${escapeHtml(state.me.username)}</div>
          </div>
        </div>
        <div class="menu-item" id="addContact">＋ &nbsp; افزودن مخاطب (شماره / ایمیل)</div>
        <div class="menu-item" id="findUser">🔍 &nbsp; پیدا کردن کاربر</div>
        <div class="menu-item" id="newGroup">👥 &nbsp; گروه جدید</div>
        <div class="menu-item" id="logout">⎋ &nbsp; خروج</div>
      </div>
    </div>`;
  renderList();
  renderMain();
  $("#menuBtn").onclick = () => $("#drawer").classList.add("open");
  $("#drawer").onclick = (e) => { if (e.target.id === "drawer") e.target.classList.remove("open"); };
  $$(".folder").forEach(b => b.onclick = () => { state.folder = b.dataset.f; renderApp(); });
  $("#q").oninput = (e) => { state.query = e.target.value.trim(); renderList(); };
  $("#logout").onclick = () => { localStorage.clear(); location.reload(); };
  $("#findUser").onclick = findUser;
  $("#addContact").onclick = addContact;
  $("#newGroup").onclick = newGroup;
}

function renderList() {
  const list = $("#list");
  if (!list) return;
  const rows = filteredChats();
  list.innerHTML = rows.length ? rows.map(c => `
    <div class="chat-item ${c.id===state.activeId?"active":""}" data-id="${c.id}">
      <div class="avatar ${c.online?"online":""}" style="background:${colorFor(c.title)}">${initials(c.title)}</div>
      <div class="chat-meta">
        <div class="row1"><span class="name">${escapeHtml(c.title)}</span><span class="time">${c.time?fmtTime(c.time):""}</span></div>
        <div class="row2"><span class="preview">${escapeHtml(c.last||"")}</span>${c.unread?`<span class="badge">${c.unread}</span>`:""}</div>
      </div>
    </div>`).join("") : `<div style="padding:24px;color:var(--text-secondary);text-align:center">هنوز گفتگویی نیست. از منو کاربر پیدا کن.</div>`;
  $$(".chat-item").forEach(el => el.onclick = () => openChat(el.dataset.id));
}

function renderMain() {
  const main = $("#main");
  const chat = state.chats.find(c => c.id === state.activeId);
  if (!chat) {
    main.className = "main empty-state";
    main.innerHTML = `<div class="wallpaper"></div><div style="z-index:1;text-align:center">یک گفتگو را انتخاب کن یا از منو کاربر جدید پیدا کن</div>`;
    return;
  }
  main.className = "main";
  main.innerHTML = `
    <div class="wallpaper"></div>
    <header class="topbar">
      <button class="icon-btn" id="back">‹</button>
      <div class="avatar" style="width:40px;height:40px;font-size:14px;background:${colorFor(chat.title)}">${initials(chat.title)}</div>
      <div class="top-info">
        <div class="name">${escapeHtml(chat.title)}</div>
        <div class="status" id="status">${statusText(chat)}</div>
      </div>
    </header>
    <div class="messages" id="msgs"></div>
    <form class="composer" id="composer">
      <textarea id="input" rows="1" placeholder="پیام"></textarea>
      <button class="send" type="submit">➤</button>
    </form>`;
  renderMessages();
  $("#back").onclick = () => { state.activeId = null; renderApp(); };
  const ta = $("#input");
  let typingTimer;
  ta.addEventListener("input", () => {
    ta.style.height = "42px";
    ta.style.height = Math.min(ta.scrollHeight,140)+"px";
    state.socket.emit("typing", { chatId: chat.id, on: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => state.socket.emit("typing", { chatId: chat.id, on: false }), 900);
  });
  $("#composer").onsubmit = (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    state.socket.emit("message", { chatId: chat.id, text });
    state.socket.emit("typing", { chatId: chat.id, on: false });
    ta.value = "";
    ta.style.height = "42px";
  };
}

function renderMessages() {
  const box = $("#msgs");
  const chat = state.chats.find(c => c.id === state.activeId);
  if (!box || !chat) return;
  const msgs = state.messages[chat.id] || [];
  let lastDay = "";
  box.innerHTML = msgs.map(m => {
    const day = new Date(m.t).toLocaleDateString("fa-IR");
    const dayHtml = day !== lastDay ? `<div class="day">${day}</div>` : "";
    lastDay = day;
    const mine = m.from === state.me.id;
    const name = !mine && chat.type === "group" && m.name
      ? `<div style="color:${colorFor(m.name)};font-size:13px;font-weight:600">${escapeHtml(m.name)}</div>` : "";
    return `${dayHtml}<div class="msg ${mine?"out":"in"}"><div class="bubble">${name}<div class="text">${escapeHtml(m.text)}</div><div class="meta-line">${fmtTime(m.t)}${mine?'<span class="checks">✓✓</span>':""}</div></div></div>`;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

function openChat(id) {
  state.activeId = id;
  state.socket.emit("load_messages", id, ({ messages, error }) => {
    if (error) return alert(error);
    state.messages[id] = messages;
    renderApp();
  });
}

function addContact() {
  const q = prompt("شماره موبایل، ایمیل یا نام‌کاربری مخاطب:");
  if (!q) return;
  state.socket.emit("add_contact", q, (res) => {
    if (res.error) return alert(res.error);
    const ok = confirm(res.contact.name + " اضافه شد. الان پیام بفرستی؟");
    if (ok) {
      state.socket.emit("open_direct", res.contact.id, ({ chat, messages, error }) => {
        if (error) return alert(error);
        const i = state.chats.findIndex(c => c.id === chat.id);
        if (i>=0) state.chats[i]=chat; else state.chats.unshift(chat);
        state.messages[chat.id] = messages;
        state.activeId = chat.id;
        renderApp();
      });
    }
  });
}

function findUser() {
  const q = prompt("نام‌کاربری، شماره یا ایمیل طرف را بنویس:");
  if (q == null) return;
  state.socket.emit("search_users", q, (list) => {
    if (!list.length) return alert("کسی پیدا نشد. طرف باید در یزدان حساب ساخته باشد.");
    const pick = list.length === 1 ? list[0] : list.find(u => u.username === q.replace("@","").toLowerCase()) || list[0];
    const ok = confirm("شروع گفتگو با " + pick.name + " (@" + pick.username + ") ؟");
    if (!ok) return;
    state.socket.emit("open_direct", pick.id, ({ chat, messages, error }) => {
      if (error) return alert(error);
      const i = state.chats.findIndex(c => c.id === chat.id);
      if (i>=0) state.chats[i]=chat; else state.chats.unshift(chat);
      state.messages[chat.id] = messages;
      state.activeId = chat.id;
      renderApp();
    });
  });
}

function newGroup() {
  const title = prompt("نام گروه:");
  if (!title) return;
  state.socket.emit("create_group", { title, memberIds: [] }, ({ chat, messages, error }) => {
    if (error) return alert(error);
    state.chats.unshift(chat);
    state.messages[chat.id] = messages;
    state.activeId = chat.id;
    renderApp();
  });
}

if (state.token) connect(); else renderAuth();
window.addEventListener("resize", () => { if (state.me && state.socket) renderApp(); });
