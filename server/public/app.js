(() => {
"use strict";
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const PALETTE = ["#2f7d63","#3b6aa8","#a8553b","#7c4fa6","#a0782a","#2f8a95","#b04a6f","#5a7a2f"];
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const colorFor = s => PALETTE[hash(s) % PALETTE.length];
const initials = n => (n || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("") || "?";
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
const Android = window.KrugAndroid || null;
const isHidden = () => document.hidden || window.krugHidden === true;

const S = { token: ls.get("krug.token"), me: null, users: {}, mine: [], explore: [], tab: "chats", q: "", active: null, msgs: [], hasMore: false, fresh: new Set(), selMsg: null, es: null };

// ---------- API ----------
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + (S.token || "") }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error("Нет связи с сервером. Проверьте интернет."); }
  let data = {}; try { data = await res.json(); } catch {}
  if (res.status === 401) { if (S.me) logout(true); else { S.token = null; ls.set("krug.token", null); } }
  if (!res.ok) throw new Error(data.error || "Ошибка " + res.status);
  return data;
}

// ---------- форматирование ----------
function plural(n, a, b, c) { const m10 = n % 10, m100 = n % 100; return n + " " + (m10 === 1 && m100 !== 11 ? a : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c)); }
const fmtTime = t => new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
function fmtShort(t) { if (!t) return ""; const d = new Date(t), n = new Date();
  if (d.toDateString() === n.toDateString()) return fmtTime(t);
  if (n - d < 6 * 864e5) return d.toLocaleDateString("ru-RU", { weekday: "short" });
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }); }
function fmtDay(t) { const d = new Date(t), n = new Date(), y = new Date(n - 864e5);
  if (d.toDateString() === n.toDateString()) return "Сегодня";
  if (d.toDateString() === y.toDateString()) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" }); }
function seen(u) { if (!u) return ""; if (u.online) return "в сети"; const t = u.lastSeen; if (!t) return "давно не заходил(а)";
  const m = Math.round((Date.now() - t) / 6e4); if (m < 1) return "был(а) только что"; if (m < 60) return "был(а) " + m + " мин назад";
  if (m < 1440) return "был(а) в " + fmtTime(t); return "был(а) " + fmtShort(t); }
const membersLabel = c => plural((c.members || []).length, c.type === "channel" ? "подписчик" : "участник", c.type === "channel" ? "подписчика" : "участника", c.type === "channel" ? "подписчиков" : "участников");

// ---------- модель ----------
const nick = id => (S.users[id] && S.users[id].name) || "Участник";
const otherOf = c => (c.members || []).find(x => x !== S.me.id) ?? S.me.id;
const chatTitle = c => c.type === "dm" ? (otherOf(c) === S.me.id ? "Избранное" : nick(otherOf(c))) : (c.title || "Без названия");
const isAdmin = c => (c.admins || []).includes(S.me.id);
const isOnline = id => id !== S.me.id && S.users[id] && S.users[id].online;
const allChats = () => { const m = new Map(); for (const c of S.explore) m.set(c.id, c); for (const c of S.mine) m.set(c.id, c); return m; };
const findChat = id => allChats().get(id);
function upsertChat(c) {
  S.mine = S.mine.filter(x => x.id !== c.id); S.explore = S.explore.filter(x => x.id !== c.id);
  if (c.isMember) S.mine.push(c);
  if (c.public && c.type !== "dm") S.explore.push(c);
  S.mine.sort((a, b) => b.lastAt - a.lastAt);
}
const kindLabel = { dm: "", group: "Группа", channel: "Канал" };

// ---------- графика ----------
const ICON = { group: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.5 3.2-5.5 6.5-5.5s6 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 010 6.8M18 14.8c2 .7 3.2 2.5 3.5 5.2"/></svg>',
  channel: '<svg viewBox="0 0 24 24"><path d="M3 10v4h3l7 5V5L6 10H3z"/><path d="M17 8.5a5 5 0 010 7"/></svg>' };
const EMPTY_SVG = '<svg viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="25" fill="none" stroke="var(--line)" stroke-width="3"/><circle cx="28" cy="28" r="15" fill="none" stroke="var(--accent)" stroke-width="3" stroke-dasharray="4 5"/><circle cx="28" cy="28" r="5" fill="var(--accent)"/></svg>';
function ava(name, key, o = {}) {
  const a = el("div", "ava" + (o.sq ? " sq" : "") + (o.sm ? " sm" : "") + (o.self ? " self" : ""));
  if (o.self) a.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>'; else a.textContent = initials(name);
  const c = colorFor(key); a.style.background = "linear-gradient(145deg, color-mix(in srgb, " + c + " 62%, #fff), " + c + ")";
  if (o.on) a.appendChild(el("span", "on"));
  a.setAttribute("aria-hidden", "true"); return a;
}
function emptyBox(t, d) { const e = el("div", "empty"); e.insertAdjacentHTML("beforeend", EMPTY_SVG); e.appendChild(el("b", null, t)); if (d) e.appendChild(document.createTextNode(d)); return e; }
function toast(t) { const x = el("div", "toast", t); document.body.appendChild(x); setTimeout(() => x.remove(), 2800); }
function linkify(node, text) {
  const re = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g; let i = 0, m;
  while ((m = re.exec(text))) { if (m.index > i) node.appendChild(document.createTextNode(text.slice(i, m.index)));
    const a = el("a", null, m[0]); a.href = m[0]; a.target = "_blank"; a.rel = "noopener noreferrer"; node.appendChild(a); i = m.index + m[0].length; }
  if (i < text.length) node.appendChild(document.createTextNode(text.slice(i)));
}

// ---------- вход ----------
let regMode = false;
function showAuth() {
  $("#app").hidden = true; $("#authView").hidden = false;
  const inv = new URLSearchParams(location.search).get("invite");
  if (inv) { $("#aInvite").value = inv; setRegMode(true); }
}
function setRegMode(on) {
  regMode = on; $("#tabLogin").setAttribute("aria-pressed", !on); $("#tabReg").setAttribute("aria-pressed", on);
  $("#fInvite").hidden = $("#fName").hidden = !on; $("#aBtn").textContent = on ? "Создать аккаунт" : "Войти";
  $("#aPass").autocomplete = on ? "new-password" : "current-password"; $("#aErr").textContent = "";
}
$("#tabLogin").onclick = () => setRegMode(false);
$("#tabReg").onclick = () => setRegMode(true);
$("#authForm").onsubmit = async e => {
  e.preventDefault(); const btn = $("#aBtn"); btn.disabled = true; $("#aErr").textContent = "";
  try {
    const body = { username: $("#aUser").value.trim(), password: $("#aPass").value };
    if (regMode) { body.invite = $("#aInvite").value.trim(); body.name = $("#aName").value.trim(); }
    const r = await api("POST", regMode ? "/api/register" : "/api/login", body);
    S.token = r.token; ls.set("krug.token", r.token);
    if (location.search) history.replaceState(null, "", "/");
    await start();
  } catch (err) { $("#aErr").textContent = err.message; }
  btn.disabled = false;
};
function logout(expired) {
  if (!expired) api("POST", "/api/logout").catch(() => {});
  S.token = null; S.me = null; ls.set("krug.token", null);
  if (S.es) S.es.close(); S.es = null; closeOverlay(); S.active = null;
  $("#chatView").hidden = true; $("#welcome").hidden = false; $("#app").classList.remove("in-chat");
  if (expired) toast("Сессия закончилась, войдите снова");
  showAuth();
}

// ---------- запуск ----------
async function start() {
  S.me = await api("GET", "/api/me");
  $("#authView").hidden = true; $("#app").hidden = false;
  await Promise.all([loadUsers(), loadChats()]);
  connect(); renderAll();
  if (Android && Android.ready) try { Android.ready(); } catch {}
}
async function loadUsers() { const list = await api("GET", "/api/users"); S.users = Object.fromEntries(list.map(u => [u.id, u])); }
async function loadChats() {
  const [mine, explore] = await Promise.all([api("GET", "/api/chats"), api("GET", "/api/explore")]);
  S.mine = mine; S.explore = explore;
}
async function refreshChat(id) {
  try { const c = await api("GET", "/api/chats/" + id); upsertChat(c); }
  catch { S.mine = S.mine.filter(x => x.id !== id); S.explore = S.explore.filter(x => x.id !== id);
    if (S.active === id) { closeActive(); toast("Чат больше недоступен"); } }
  if (S.active === id) markRead();
  renderList(); if (S.active === id) { renderChatHead(); renderBottom(); renderMsgs(); }
}

// ---------- живые события ----------
let reconnectTimer = null;
function connect() {
  if (S.es) S.es.close();
  const es = new EventSource("/api/events?token=" + encodeURIComponent(S.token)); S.es = es;
  let opened = false;
  es.onopen = async () => {
    $("#conn").hidden = true;
    if (opened) { try { await Promise.all([loadUsers(), loadChats()]); renderAll(); if (S.active) loadMsgs(); } catch {} }
    opened = true;
  };
  es.onerror = () => {
    $("#conn").hidden = false;
    if (es.readyState === EventSource.CLOSED) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(async () => {
      try { await api("GET", "/api/me"); connect(); } catch {} }, 4000); }
  };
  es.addEventListener("message", e => {
    const { chatId, message } = JSON.parse(e.data);
    if (chatId === S.active && !S.msgs.some(m => m.id === message.id)) { S.fresh = new Set([message.id]); S.msgs.push(message); renderMsgs(); markRead(); }
    if (message.by !== S.me.id && (isHidden() || chatId !== S.active)) notify(chatId, message);
  });
  es.addEventListener("chat", e => { const { chatId } = JSON.parse(e.data); refreshChat(chatId); });
  es.addEventListener("delete", e => { const { chatId, id } = JSON.parse(e.data); if (chatId === S.active) { S.msgs = S.msgs.filter(m => m.id !== id); renderMsgs(); } });
  es.addEventListener("user", async () => { await loadUsers().catch(() => {}); renderAll(); });
  es.addEventListener("presence", e => { const p = JSON.parse(e.data); const u = S.users[p.userId]; if (u) { u.online = p.online; u.lastSeen = p.lastSeen; renderList(); renderChatHead(); } });
  es.addEventListener("read", e => { const r = JSON.parse(e.data); const c = findChat(r.chatId); if (c && r.userId !== S.me.id) { c.readBy = Math.max(c.readBy || 0, r.at); if (S.active === c.id) renderMsgs(); } });
}
function notify(chatId, m) {
  const c = findChat(chatId); const title = c ? (c.type === "dm" ? nick(m.by) : chatTitle(c)) : "Круг";
  const text = (c && c.type === "group" ? nick(m.by) + ": " : "") + m.text;
  if (Android && Android.notify) { try { Android.notify(String(chatId), title, text.slice(0, 300)); } catch {} return; }
  try { if ("Notification" in window && Notification.permission === "granted" && isHidden()) new Notification(title, { body: text.slice(0, 200), tag: "krug-" + chatId, icon: "/icon-192.png" }); } catch {}
}
window.krugOpenChat = id => { const n = Number(id); if (findChat(n)) openChat(n); else refreshChat(n).then(() => findChat(n) && openChat(n)); };

// ---------- список ----------
function renderList() {
  if (!S.me) return;
  const list = $("#list"); list.replaceChildren(); const q = S.q.trim().toLowerCase();
  if (S.tab === "chats") {
    let chats = S.mine.slice();
    if (q) chats = chats.filter(c => chatTitle(c).toLowerCase().includes(q));
    if (!chats.length) { list.appendChild(emptyBox(q ? "Ничего не найдено" : "Пока нет чатов", q ? "" : "Откройте «Люди», чтобы написать кому-то, или «Обзор», чтобы вступить в группу.")); return; }
    for (const c of chats) list.appendChild(chatRow(c));
  }
  if (S.tab === "people") {
    let ppl = Object.values(S.users).sort((a, b) => (b.id === S.me.id) - (a.id === S.me.id) || (b.online - a.online) || (b.lastSeen - a.lastSeen));
    if (q) ppl = ppl.filter(p => (p.name + " " + p.username).toLowerCase().includes(q));
    if (!ppl.length) { list.appendChild(emptyBox("Никого не найдено", "")); return; }
    for (const p of ppl) {
      const b = el("button", "row"); const self = p.id === S.me.id;
      b.appendChild(ava(p.name, p.id, { self, on: isOnline(p.id) }));
      const mm = el("div", "rmain"); const top = el("div", "rtop");
      top.appendChild(el("span", "rname", self ? "Избранное" : p.name));
      if (!self) top.appendChild(el("span", "meta", "@" + p.username));
      mm.appendChild(top);
      mm.appendChild(el("div", "prev", self ? "Заметки для себя" : (p.bio || seen(p))));
      b.appendChild(mm); b.onclick = () => openDM(p.id); list.appendChild(b);
    }
    if (Object.keys(S.users).length < 2) list.appendChild(emptyBox("Здесь пока только вы", S.me.isAdmin ? "Пригласите друзей: ссылка с кодом есть в вашем профиле внизу." : "Попросите администратора сети пригласить друзей."));
  }
  if (S.tab === "explore") {
    let pubs = S.explore.slice().sort((a, b) => b.members.length - a.members.length);
    if (q) pubs = pubs.filter(c => chatTitle(c).toLowerCase().includes(q));
    if (!pubs.length) { list.appendChild(emptyBox("Открытых групп пока нет", "Создайте первую группу или канал кнопкой «+».")); return; }
    for (const t of ["channel", "group"]) {
      const part = pubs.filter(c => c.type === t); if (!part.length) continue;
      list.appendChild(el("div", "section-label", t === "channel" ? "Каналы" : "Группы"));
      for (const c of part) list.appendChild(chatRow(c, true));
    }
  }
}
function chatRow(c, explore) {
  const b = el("button", "row" + (S.active === c.id ? " active" : ""));
  const title = chatTitle(c); const selfDm = c.type === "dm" && otherOf(c) === S.me.id;
  b.appendChild(ava(title, c.type === "dm" ? otherOf(c) : "c" + c.id, { sq: c.type !== "dm", self: selfDm, on: c.type === "dm" && isOnline(otherOf(c)) }));
  const mm = el("div", "rmain"); const top = el("div", "rtop");
  const rn = el("span", "rname"); if (ICON[c.type]) { const bd = el("span", "badge"); bd.innerHTML = ICON[c.type]; rn.appendChild(bd); }
  rn.appendChild(document.createTextNode(title)); top.appendChild(rn);
  if (!explore) top.appendChild(el("span", "meta", c.lastText ? fmtShort(c.lastAt) : ""));
  mm.appendChild(top);
  const prev = el("div", "prev"); prev.style.flex = "1";
  if (explore) prev.textContent = kindLabel[c.type] + " · " + membersLabel(c) + (c.about ? " · " + c.about : "");
  else if (c.lastText) {
    const who = c.lastBy === S.me.id && !selfDm ? "Вы: " : (c.type === "group" && c.lastBy ? nick(c.lastBy) + ": " : "");
    if (who) prev.appendChild(el("span", "from", who)); prev.appendChild(document.createTextNode(c.lastText));
  } else prev.textContent = c.type === "dm" ? (selfDm ? "Заметки для себя" : "Начните переписку") : (c.about || kindLabel[c.type]);
  const row2 = el("div", "rtop"); row2.appendChild(prev);
  if (!explore && c.unread && S.active !== c.id) row2.appendChild(el("span", "unread-n", c.unread > 99 ? "99+" : String(c.unread)));
  if (explore && !c.isMember) row2.appendChild(el("span", "join-chip", c.type === "channel" ? "Подписаться" : "Вступить"));
  mm.appendChild(row2); b.appendChild(mm);
  b.onclick = () => openChat(c.id);
  return b;
}
function renderMe() {
  const bar = $("#meBar"); if (!S.me) return; const me = S.users[S.me.id] || S.me;
  bar.replaceChildren(ava(me.name, me.id, { sm: true }));
  const n = el("div", "rmain"); n.appendChild(el("div", "rname", me.name)); n.appendChild(el("div", "prev", "@" + me.username)); bar.appendChild(n);
  const edit = el("button", "iconbtn"); edit.setAttribute("aria-label", "Профиль и настройки");
  edit.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>';
  edit.onclick = profileDialog; bar.appendChild(edit);
}

// ---------- чат ----------
async function openChat(id) {
  const changed = S.active !== id;
  S.active = id; $("#app").classList.add("in-chat");
  $("#welcome").hidden = true; $("#chatView").hidden = false;
  if (changed) { S.msgs = []; S.selMsg = null; S.fresh = new Set(); S.scrolled = false; buildChatView(); await loadMsgs(); }
  else buildChatView();
  renderList(); markRead();
  if (Android && Android.openedChat) try { Android.openedChat(String(id)); } catch {}
}
function closeActive() { S.active = null; $("#chatView").hidden = true; $("#welcome").hidden = false; $("#app").classList.remove("in-chat"); renderList(); }
window.krugBack = () => { if ($(".overlay")) { closeOverlay(); return true; } if ($("#app").classList.contains("in-chat") && innerWidth <= 720) { $("#app").classList.remove("in-chat"); return true; } return false; };
async function loadMsgs(older) {
  const id = S.active; if (!id) return;
  try {
    const before = older && S.msgs.length ? S.msgs[0].at : "";
    const list = await api("GET", `/api/chats/${id}/messages?limit=60${before ? "&before=" + before : ""}`);
    if (S.active !== id) return;
    S.hasMore = list.length === 60;
    if (older) { const box = $("#msgs"); const h = box.scrollHeight; S.msgs = list.concat(S.msgs); S.fresh = new Set(); renderMsgs(); box.scrollTop = box.scrollHeight - h; }
    else { S.msgs = list; S.scrolled = false; renderMsgs(); }
  } catch (e) { toast(e.message); }
}
function buildChatView() {
  const cv = $("#chatView"); cv.replaceChildren();
  const head = el("div", "chat-head"); head.id = "chatHead";
  const msgs = el("div", "msgs"); msgs.id = "msgs"; msgs.setAttribute("aria-live", "polite");
  const bottom = el("div"); bottom.id = "bottom"; bottom.style.display = "contents";
  cv.append(head, msgs, bottom); renderChatHead(); renderMsgs(); renderBottom();
}
function renderChatHead() {
  const head = $("#chatHead"); if (!head || !S.active) return; const c = findChat(S.active); if (!c) return;
  head.replaceChildren();
  const back = el("button", "iconbtn back"); back.setAttribute("aria-label", "Назад к чатам");
  back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>'; back.onclick = () => $("#app").classList.remove("in-chat");
  const title = chatTitle(c); const t = el("div", "t"); t.appendChild(el("b", null, title));
  const sub = c.type === "dm" ? (otherOf(c) === S.me.id ? "заметки для себя" : seen(S.users[otherOf(c)])) : membersLabel(c);
  t.appendChild(el("span", sub === "в сети" ? "online" : null, sub)); t.onclick = () => infoDialog(c);
  const info = el("button", "iconbtn"); info.setAttribute("aria-label", "Информация о чате");
  info.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>'; info.onclick = () => infoDialog(c);
  const hv = ava(title, c.type === "dm" ? otherOf(c) : "c" + c.id, { sq: c.type !== "dm", self: c.type === "dm" && otherOf(c) === S.me.id, on: c.type === "dm" && isOnline(otherOf(c)) });
  hv.style.width = hv.style.height = "42px"; hv.style.fontSize = "15px";
  head.append(back, hv, t, info);
}
function renderMsgs() {
  const box = $("#msgs"); if (!box) return; const c = findChat(S.active); if (!c) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.replaceChildren();
  if (S.hasMore) { const more = el("button", "more", "Показать более ранние"); more.onclick = () => loadMsgs(true); box.appendChild(more); }
  if (!S.msgs.length) {
    const e = emptyBox(c.type === "channel" ? "В канале пока нет постов" : "Сообщений пока нет",
      c.type === "channel" ? (isAdmin(c) ? "Напишите первый пост ниже." : "Посты появятся здесь.") : "Напишите первое сообщение ниже.");
    e.style.margin = "auto"; box.appendChild(e); return;
  }
  let lastDay = "", lastBy = null, lastAt = 0;
  for (const m of S.msgs) {
    const day = new Date(m.at).toDateString();
    if (day !== lastDay) { box.appendChild(el("div", "day", fmtDay(m.at))); lastDay = day; lastBy = null; }
    const mine = m.by === S.me.id; const first = lastBy !== m.by || m.at - lastAt > 5 * 60e3;
    const row = el("div", (c.type === "channel" ? "m post" : "m" + (mine ? " me" : "")) + (first ? " first" : "") + (S.selMsg === m.id ? " sel" : "") + (S.fresh.has(m.id) ? " new" : ""));
    if (c.type === "group" && !mine) row.appendChild(first ? ava(nick(m.by), m.by, { sm: true }) : el("div", "spacer"));
    const bub = el("div", "bub");
    if (first && ((c.type === "group" && !mine) || c.type === "channel")) {
      const w = el("div", "who", c.type === "channel" ? chatTitle(c) : nick(m.by)); w.style.color = c.type === "channel" ? "var(--accent)" : colorFor(m.by); bub.appendChild(w);
    }
    const tx = el("div", "tx"); linkify(tx, m.text);
    const tm = el("span", "tm", fmtTime(m.at));
    if (mine && c.type !== "channel") tm.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 15 11" aria-label="' + (m.at <= (c.readBy || 0) ? "прочитано" : "отправлено") + '"><path d="M1 6l3.5 3.5L11 2"/>' + (m.at <= (c.readBy || 0) && otherOf(c) !== S.me.id ? '<path d="M6.5 9.5L14 2"/>' : "") + "</svg>");
    tx.appendChild(tm); bub.appendChild(tx);
    if (mine || isAdmin(c)) {
      row.classList.add("canDel");
      const del = el("button", "del", "Удалить"); del.onclick = ev => { ev.stopPropagation(); deleteMsg(m); };
      bub.appendChild(del); row.onclick = () => { S.selMsg = S.selMsg === m.id ? null : m.id; renderMsgs(); };
    }
    row.appendChild(bub); box.appendChild(row); lastBy = m.by; lastAt = m.at;
  }
  if (atBottom || !S.scrolled) { box.scrollTop = box.scrollHeight; S.scrolled = true; }
}
function renderBottom() {
  const b = $("#bottom"); if (!b) return; b.replaceChildren(); const c = findChat(S.active); if (!c) return;
  if (!c.isMember) { const n = el("div", "notice"); const btn = el("button", "btn", c.type === "channel" ? "Подписаться" : "Вступить в группу"); btn.onclick = () => join(c); n.appendChild(btn); b.appendChild(n); return; }
  if (c.type === "channel" && !isAdmin(c)) { b.appendChild(el("div", "notice", "Публиковать в канале могут только его администраторы")); return; }
  const f = el("form", "composer");
  const ta = el("textarea"); ta.id = "composerText"; ta.rows = 1; ta.maxLength = 4000;
  ta.placeholder = c.type === "channel" ? "Новый пост…" : "Сообщение…"; ta.setAttribute("aria-label", "Текст сообщения"); ta.setAttribute("enterkeyhint", "send");
  const key = "krug.draft." + c.id; ta.value = ls.get(key) || "";
  const send = el("button", "send"); send.type = "submit"; send.setAttribute("aria-label", "Отправить");
  send.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3.4 20.4l17.5-7.5c.8-.4.8-1.5 0-1.8L3.4 3.6c-.7-.3-1.4.3-1.2 1l1.8 6.4 9 1-9 1-1.8 6.4c-.2.7.5 1.3 1.2 1z"/></svg>';
  const fit = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 2, 160) + "px"; send.disabled = !ta.value.trim(); };
  ta.oninput = () => { fit(); ls.set(key, ta.value); };
  ta.onfocus = () => setTimeout(() => { const bx = $("#msgs"); if (bx) bx.scrollTop = bx.scrollHeight; }, 300);
  const touch = matchMedia("(pointer: coarse)").matches;
  ta.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); f.requestSubmit(); } };
  let sending = false;
  f.onsubmit = async e => {
    e.preventDefault(); const text = ta.value.trim(); if (!text || sending) return; sending = true; send.disabled = true;
    try { const m = await api("POST", `/api/chats/${c.id}/messages`, { text });
      if (!S.msgs.some(x => x.id === m.id)) { S.fresh = new Set([m.id]); S.msgs.push(m); }
      ta.value = ""; ls.set(key, null); S.scrolled = false; renderMsgs(); }
    catch (err) { toast(err.message); }
    sending = false; fit(); ta.focus();
  };
  f.append(ta, send); b.appendChild(f); requestAnimationFrame(fit);
}

// ---------- действия ----------
let readTimer = null;
function markRead() {
  const c = findChat(S.active); if (!c || !c.isMember || isHidden() || !c.unread) return;
  c.unread = 0; renderList();
  clearTimeout(readTimer); readTimer = setTimeout(() => api("POST", `/api/chats/${c.id}/read`).catch(() => {}), 400);
}
async function deleteMsg(m) {
  try { await api("DELETE", "/api/messages/" + m.id); S.msgs = S.msgs.filter(x => x.id !== m.id); renderMsgs(); toast("Сообщение удалено"); }
  catch (e) { toast(e.message); }
}
async function join(c) { try { upsertChat(await api("POST", `/api/chats/${c.id}/join`)); renderAll(); toast(c.type === "channel" ? "Вы подписались" : "Вы в группе"); } catch (e) { toast(e.message); } }
async function leave(c) {
  try { await api("POST", `/api/chats/${c.id}/leave`); closeOverlay(); await refreshChat(c.id); if (S.active === c.id && !c.public) closeActive(); toast("Вы вышли"); }
  catch (e) { toast(e.message); }
}
async function openDM(uid) {
  try { const c = await api("POST", "/api/dm/" + uid); upsertChat(c); setTab("chats"); openChat(c.id); } catch (e) { toast(e.message); }
}

// ---------- окна ----------
function closeOverlay() { const o = $(".overlay"); if (o) o.remove(); }
function overlay(build) {
  closeOverlay(); const o = el("div", "overlay"); const d = el("div", "dialog"); d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true");
  o.appendChild(d); build(d); document.body.appendChild(o);
  o.addEventListener("click", e => { if (e.target === o) closeOverlay(); });
  const f = d.querySelector("input,textarea"); if (f && !matchMedia("(pointer: coarse)").matches) f.focus();
}
document.addEventListener("keydown", e => { if (e.key === "Escape") closeOverlay(); });
function copyText(text, input) {
  const done = () => toast("Скопировано");
  if (Android && Android.copy) { try { Android.copy(text); return done(); } catch {} }
  navigator.clipboard.writeText(text).then(done, () => { if (input) { const r = document.createRange(); r.selectNodeContents(input); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("Выделено — скопируйте вручную"); } });
}

function profileDialog() {
  const me = S.users[S.me.id] || S.me;
  overlay(d => {
    const dh = el("div", "dhead"); const pv = ava(me.name, me.id); dh.append(pv, el("h2", null, me.name), el("p", null, "@" + me.username)); d.appendChild(dh);
    const f = el("form");
    f.innerHTML = '<div class="field"><label for="pfName">Имя</label><input id="pfName" maxlength="40" required></div><div class="field"><label for="pfBio">О себе</label><input id="pfBio" maxlength="120" placeholder="Необязательно"></div><div class="err" id="pfErr"></div><div class="d-acts"><button class="btn" id="pfSave">Сохранить</button></div>';
    f.querySelector("#pfName").value = me.name; f.querySelector("#pfBio").value = me.bio || "";
    f.onsubmit = async e => { e.preventDefault();
      try { await api("PATCH", "/api/me", { name: f.querySelector("#pfName").value, bio: f.querySelector("#pfBio").value }); await loadUsers(); renderAll(); closeOverlay(); toast("Профиль сохранён"); }
      catch (err) { f.querySelector("#pfErr").textContent = err.message; } };
    d.appendChild(f);

    if (S.me.isAdmin) {
      const sec = el("div", "dsec"); sec.appendChild(el("h3", null, "Приглашение друзей"));
      sec.appendChild(el("p", "hint", "Отправьте другу ссылку. Без неё или без кода зарегистрироваться нельзя."));
      const link = location.origin + "/?invite=" + encodeURIComponent(S.me.invite);
      const row = el("div", "copyrow"); const code = el("code", null, link); const cb = el("button", "btn sm", "Копировать"); cb.type = "button"; cb.onclick = () => copyText(link, code);
      row.append(code, cb); sec.appendChild(row);
      const f2 = el("form"); f2.style.marginTop = "12px";
      f2.innerHTML = '<div class="field"><label for="invCode">Код приглашения</label><input id="invCode" maxlength="64"></div><div class="d-acts" style="margin-top:0"><button class="btn ghost sm">Сменить код</button></div>';
      f2.querySelector("#invCode").value = S.me.invite;
      f2.onsubmit = async e => { e.preventDefault(); try { const r = await api("POST", "/api/invite", { code: f2.querySelector("#invCode").value }); S.me.invite = r.invite; toast("Код изменён, старая ссылка больше не работает"); profileDialog(); } catch (err) { toast(err.message); } };
      sec.appendChild(f2); d.appendChild(sec);
    }

    const ps = el("div", "dsec"); ps.appendChild(el("h3", null, "Сменить пароль"));
    const f3 = el("form");
    f3.innerHTML = '<div class="field"><label for="pwOld">Текущий пароль</label><input id="pwOld" type="password" autocomplete="current-password"></div><div class="field"><label for="pwNew">Новый пароль</label><input id="pwNew" type="password" autocomplete="new-password" minlength="6"></div><div class="err" id="pwErr"></div><div class="d-acts" style="margin-top:0"><button class="btn ghost sm">Сменить пароль</button></div>';
    f3.onsubmit = async e => { e.preventDefault();
      try { await api("PATCH", "/api/me", { oldPassword: f3.querySelector("#pwOld").value, newPassword: f3.querySelector("#pwNew").value }); toast("Пароль изменён"); f3.reset(); }
      catch (err) { f3.querySelector("#pwErr").textContent = err.message; } };
    ps.appendChild(f3); d.appendChild(ps);

    const acts = el("div", "d-acts");
    if (Android && Android.changeServer) { const sv = el("button", "btn ghost", "Сменить сервер"); sv.onclick = () => { try { Android.changeServer(); } catch {} }; acts.appendChild(sv); }
    else if ("Notification" in window && Notification.permission === "default") { const nb = el("button", "btn ghost", "Включить уведомления"); nb.onclick = () => Notification.requestPermission().then(p => toast(p === "granted" ? "Уведомления включены" : "Уведомления не разрешены")); acts.appendChild(nb); }
    const lo = el("button", "btn danger", "Выйти"); lo.onclick = () => logout(false); acts.appendChild(lo);
    const cl = el("button", "btn", "Закрыть"); cl.onclick = closeOverlay; acts.appendChild(cl);
    d.appendChild(acts);
  });
}

function newDialog() {
  let type = "group";
  overlay(d => {
    d.appendChild(el("h2", null, "Создать"));
    const seg = el("div", "seg"); const bG = el("button", null, "Группа"), bC = el("button", null, "Канал"); bG.type = bC.type = "button";
    seg.append(bG, bC); d.appendChild(seg);
    const f = el("form");
    f.innerHTML = '<div class="field"><label for="ncTitle">Название</label><input id="ncTitle" maxlength="60" required></div><div class="field"><label for="ncAbout">Описание</label><input id="ncAbout" maxlength="160" placeholder="Необязательно"></div><label class="check"><input type="checkbox" id="ncPublic" checked><span>Показывать в «Обзоре», чтобы любой участник сети мог вступить</span></label><div id="ncPickWrap"><div class="field"><label>Добавить участников</label><div class="pick" id="ncPick"></div></div></div><div class="err" id="ncErr"></div><div class="d-acts"><button type="button" class="btn ghost" id="ncCancel">Отмена</button><button class="btn" id="ncOk">Создать</button></div>';
    d.appendChild(f);
    const pick = f.querySelector("#ncPick"); const ppl = Object.values(S.users).filter(u => u.id !== S.me.id);
    if (!ppl.length) pick.appendChild(el("div", "hint", "Других участников пока нет."));
    for (const p of ppl) { const l = el("label"); const cb = el("input"); cb.type = "checkbox"; cb.value = p.id; cb.id = "ncp-" + p.id; l.append(cb, ava(p.name, p.id, { sm: true, on: isOnline(p.id) }), el("span", "nm", p.name)); pick.appendChild(l); }
    const sync = () => { bG.setAttribute("aria-pressed", type === "group"); bC.setAttribute("aria-pressed", type === "channel"); f.querySelector("#ncPickWrap").hidden = type === "channel"; f.querySelector("#ncOk").textContent = type === "channel" ? "Создать канал" : "Создать группу"; };
    bG.onclick = () => { type = "group"; sync(); }; bC.onclick = () => { type = "channel"; sync(); }; sync();
    f.querySelector("#ncCancel").onclick = closeOverlay;
    f.onsubmit = async e => { e.preventDefault(); const btn = f.querySelector("#ncOk"); btn.disabled = true;
      try { const c = await api("POST", "/api/chats", { type, title: f.querySelector("#ncTitle").value, about: f.querySelector("#ncAbout").value, public: f.querySelector("#ncPublic").checked, members: [...pick.querySelectorAll("input:checked")].map(x => Number(x.value)) });
        upsertChat(c); closeOverlay(); setTab("chats"); openChat(c.id); }
      catch (err) { btn.disabled = false; f.querySelector("#ncErr").textContent = err.message; } };
  });
}

function infoDialog(c) {
  overlay(d => {
    const ih = el("div", "dhead"); const other = c.type === "dm" ? S.users[otherOf(c)] : null;
    ih.appendChild(ava(chatTitle(c), c.type === "dm" ? otherOf(c) : "c" + c.id, { sq: c.type !== "dm", self: c.type === "dm" && otherOf(c) === S.me.id, on: c.type === "dm" && isOnline(otherOf(c)) }));
    ih.appendChild(el("h2", null, chatTitle(c)));
    if (other && other.id !== S.me.id) ih.appendChild(el("p", null, "@" + other.username + " · " + seen(other)));
    else if (c.type !== "dm") ih.appendChild(el("p", null, kindLabel[c.type] + " · " + membersLabel(c) + (c.public ? "" : " · закрыт(а)")));
    d.appendChild(ih);
    if (c.about) d.appendChild(el("p", null, c.about));
    if (other && other.bio && other.id !== S.me.id) d.appendChild(el("p", null, other.bio));
    if (c.type !== "dm") {
      d.appendChild(el("div", "section-label", c.type === "channel" ? "Подписчики" : "Участники"));
      const lst = el("div", "info-list");
      const ids = c.members.slice().sort((a, b) => c.admins.includes(b) - c.admins.includes(a));
      for (const id of ids) {
        const r = el("div", "row"); r.style.cursor = "default"; r.appendChild(ava(nick(id), id, { sm: true, on: isOnline(id) }));
        const mm = el("div", "rmain"); mm.appendChild(el("div", "rname", nick(id) + (id === S.me.id ? " (вы)" : "")));
        mm.appendChild(el("div", c.admins.includes(id) ? "kind" : "prev", c.admins.includes(id) ? "админ" : seen(S.users[id])));
        r.appendChild(mm);
        if (isAdmin(c) && id !== S.me.id) {
          const on = c.admins.includes(id); const mk = el("button", "btn ghost sm", on ? "Снять админа" : "Сделать админом");
          mk.onclick = async () => { try { upsertChat(await api("POST", `/api/chats/${c.id}/admins`, { userId: id, admin: !on })); closeOverlay(); renderAll(); } catch (e) { toast(e.message); } };
          r.appendChild(mk);
        }
        lst.appendChild(r);
      }
      d.appendChild(lst);
      if (c.isMember && c.type === "group") {
        const others = Object.values(S.users).filter(u => !c.members.includes(u.id));
        if (others.length) {
          d.appendChild(el("div", "section-label", "Пригласить"));
          const pk = el("div", "pick");
          for (const p of others) { const r = el("label"); const b = el("button", "btn ghost sm", "Добавить"); b.type = "button";
            b.onclick = async () => { try { upsertChat(await api("POST", `/api/chats/${c.id}/members`, { userId: p.id })); closeOverlay(); renderAll(); toast(p.name + " в группе"); } catch (e) { toast(e.message); } };
            r.append(ava(p.name, p.id, { sm: true }), el("span", "nm", p.name), b); pk.appendChild(r); }
          d.appendChild(pk);
        }
      }
    }
    const acts = el("div", "d-acts");
    if (c.type !== "dm" && c.isMember) { const lv = el("button", "btn danger", c.type === "channel" ? "Отписаться" : "Выйти из группы"); lv.onclick = () => leave(c); acts.appendChild(lv); }
    const cl = el("button", "btn", "Закрыть"); cl.onclick = closeOverlay; acts.appendChild(cl);
    d.appendChild(acts);
  });
}

// ---------- вкладки ----------
function setTab(t) { S.tab = t; document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-pressed", b.dataset.tab === t)); renderList(); }
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => setTab(b.dataset.tab));
$("#search").oninput = e => { S.q = e.target.value; renderList(); };
$("#newBtn").onclick = newDialog;
document.querySelectorAll("[data-open]").forEach(b => b.onclick = () => b.dataset.open === "new" ? newDialog() : setTab("people"));
document.addEventListener("visibilitychange", () => { if (!isHidden()) markRead(); });
window.krugResume = () => { if (S.me) { markRead(); if (S.es && S.es.readyState === EventSource.CLOSED) connect(); } };
function renderAll() { renderList(); renderMe(); if (S.active) { renderChatHead(); renderBottom(); renderMsgs(); } }
setInterval(() => { if (S.me) { renderList(); renderChatHead(); } }, 60e3);

// ---------- старт ----------
function boot() {
  if (!S.token) return showAuth();
  start().catch(e => { if (!S.token) return showAuth(); toast(e.message); setTimeout(boot, 5000); });
}
boot();
if ("serviceWorker" in navigator && !Android) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
