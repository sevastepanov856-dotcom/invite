const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const users = new Map();
const usersByNick = new Map();
const conversations = new Map();

function makeId(){ return Math.random().toString(36).slice(2, 10); }
function convoId(a,b){ return [a,b].sort().join(':'); }
function normalizeNick(nick){
  const raw = String(nick || '').trim().toLowerCase();
  return raw.startsWith('@') ? raw : '@' + raw;
}
function publicUser(u){
  return {
    id:u.id,
    name:u.name,
    nick:u.nick,
    online:!!u.online,
    email:u.email || '',
    avatar:u.avatar || '',
    lastSeenAt:u.lastSeenAt || null
  };
}
function safeImageDataUrl(v){
  const s = String(v || '');
  if (!s.startsWith('data:image/')) return '';
  if (s.length > 2_000_000) return '';
  return s;
}

function createMailer() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

const mailer = createMailer();

async function sendIncomingCallEmail({ callerName, callerNick, targetEmail, isVideo }) {
  if (!mailer || !targetEmail) return false;
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const appUrl = process.env.APP_URL || '';
  const subject = isVideo
    ? `Видеозвонок от ${callerName} (${callerNick})`
    : `Звонок от ${callerName} (${callerNick})`;
  const text = [
    `${callerName} (${callerNick}) звонит вам в WaveTalk.`,
    isVideo ? 'Тип звонка: видео.' : 'Тип звонка: аудио.',
    appUrl ? `Откройте приложение: ${appUrl}` : '',
  ].filter(Boolean).join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2 style="margin:0 0 12px">Входящий звонок в WaveTalk</h2>
      <p><strong>${callerName}</strong> (${callerNick}) звонит вам.</p>
      <p>${isVideo ? 'Тип звонка: видеозвонок.' : 'Тип звонка: аудиозвонок.'}</p>
      ${appUrl ? `<p><a href="${appUrl}">Открыть приложение</a></p>` : ''}
    </div>
  `;

  await mailer.sendMail({
    from,
    to: targetEmail,
    subject,
    text,
    html
  });
  return true;
}

async function sendIncomingMessageEmail({ senderName, senderNick, targetEmail, text }) {
  if (!mailer || !targetEmail) return false;
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const appUrl = process.env.APP_URL || '';
  const preview = String(text || '').slice(0, 180);
  const subject = `Новое сообщение от ${senderName} (${senderNick})`;
  const plainText = [
    `${senderName} (${senderNick}) отправил(а) вам сообщение в WaveTalk.`,
    `Сообщение: ${preview}`,
    appUrl ? `Открыть приложение: ${appUrl}` : '',
  ].filter(Boolean).join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2 style="margin:0 0 12px">Новое сообщение в WaveTalk</h2>
      <p><strong>${senderName}</strong> (${senderNick}) написал(а) вам.</p>
      <p style="padding:12px 14px;border-radius:12px;background:#f3f6fb;color:#111827">${preview}</p>
      ${appUrl ? `<p><a href="${appUrl}">Открыть приложение</a></p>` : ''}
    </div>
  `;

  await mailer.sendMail({
    from,
    to: targetEmail,
    subject,
    text: plainText,
    html
  });
  return true;
}

app.get('/health', (req,res) => {
  res.json({
    ok:true,
    users:users.size,
    conversations:conversations.size,
    emailConfigured: !!mailer
  });
});

app.post('/api/register', (req,res) => {
  const { name, nick, password, email } = req.body || {};
  if (!name || !nick || !password) {
    return res.status(400).json({ error:'Заполни имя, ник и пароль' });
  }
  const normalizedNick = normalizeNick(nick);
  if (!/^@[a-z0-9_]{3,20}$/.test(normalizedNick)) {
    return res.status(400).json({ error:'Ник: 3–20 символов, латиница, цифры, _' });
  }
  if (usersByNick.has(normalizedNick)) {
    return res.status(409).json({ error:'Этот ник уже занят' });
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const id = makeId();
  const user = {
    id,
    name:String(name).trim(),
    nick:normalizedNick,
    password:String(password),
    email: normalizedEmail,
    avatar:'',
    online:false,
    socketId:null,
    lastSeenAt:null
  };
  users.set(id, user);
  usersByNick.set(normalizedNick, id);
  res.json({ ok:true, user:publicUser(user) });
});

app.post('/api/login', (req,res) => {
  const { nick, password } = req.body || {};
  if (!nick || !password) return res.status(400).json({ error:'Введите ник и пароль' });
  const id = usersByNick.get(normalizeNick(nick));
  if (!id) return res.status(404).json({ error:'Пользователь не найден' });
  const user = users.get(id);
  if (user.password !== String(password)) return res.status(401).json({ error:'Неверный пароль' });
  res.json({ ok:true, user:publicUser(user) });
});

app.patch('/api/profile/avatar', (req,res) => {
  const { me, avatar } = req.body || {};
  const user = users.get(String(me || ''));
  if (!user) return res.status(404).json({ error:'Пользователь не найден' });

  const safe = safeImageDataUrl(avatar);
  if (!safe) return res.status(400).json({ error:'Нужна картинка до 2MB' });

  user.avatar = safe;
  io.emit('profile:update', publicUser(user));
  res.json({ ok:true, user:publicUser(user) });
});

app.get('/api/search', (req,res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const me = String(req.query.me || '');
  const list = [...users.values()]
    .filter(u => u.id !== me)
    .filter(u => !q || u.name.toLowerCase().includes(q) || u.nick.toLowerCase().includes(q))
    .slice(0, 50)
    .map(publicUser);
  res.json({ ok:true, users:list });
});

app.get('/api/chats', (req,res) => {
  const me = String(req.query.me || '');
  if (!me) return res.status(400).json({ error:'me required' });

  const chatIds = new Set();
  for (const [id, arr] of conversations.entries()) {
    if (!arr.length) continue;
    const parts = id.split(':');
    if (parts.includes(me)) {
      const other = parts[0] === me ? parts[1] : parts[0];
      chatIds.add(other);
    }
  }

  const chats = [...chatIds].map(id => {
    const u = users.get(id);
    if (!u) return null;
    const cid = convoId(me, id);
    const arr = conversations.get(cid) || [];
    const last = arr[arr.length - 1];
    const unread = arr.filter(m => m.to === me && !m.readAt && !m.isDeleted).length;

    return {
      ...publicUser(u),
      lastText: last ? (last.isDeleted ? 'Сообщение удалено' : last.text) : '',
      lastTime: last ? last.time : null,
      unreadCount: unread
    };
  }).filter(Boolean).sort((a,b) => {
    const ta = a.lastTime ? new Date(a.lastTime).getTime() : 0;
    const tb = b.lastTime ? new Date(b.lastTime).getTime() : 0;
    return tb - ta;
  });

  res.json({ ok:true, chats });
});

app.get('/api/messages', (req,res) => {
  const { me, other } = req.query;
  if (!me || !other) return res.status(400).json({ error:'me and other required' });
  res.json({ ok:true, messages: conversations.get(convoId(String(me), String(other))) || [] });
});
app.post('/api/messages', async (req, res) => {
  try {
    const { from, to, text, type, image, audio } = req.body || {};

    if (!from || !to) {
      return res.status(400).json({ error: 'from/to required' });
    }

    const sender = users.get(from);
    const target = users.get(to);
    if (!sender || !target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const msg = {
      id: makeId(),
      from,
      to,
      text: text || '',
      type: type || 'text',
      image: image || null,
      audio: audio || null,
      time: new Date().toISOString(),
      updatedAt: null,
      isDeleted: false,
      readAt: null
    };

    const id = convoId(from, to);
    const arr = conversations.get(id) || [];
    arr.push(msg);
    conversations.set(id, arr);

    io.to(`chat:${id}`).emit('message', msg);
    io.to(`user:${from}`).emit('chats:update');
    io.to(`user:${to}`).emit('chats:update');

    try {
      if (sender && target?.email && msg.type === 'text' && msg.text) {
        await sendIncomingMessageEmail({
          senderName: sender.name,
          senderNick: sender.nick,
          targetEmail: target.email,
          text: msg.text
        });
      }
    } catch (err) {
      console.error('Message email send failed:', err.message);
    }

    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/read', (req,res) => {
  const { me, other } = req.body || {};
  if (!me || !other) return res.status(400).json({ error:'me and other required' });

  const id = convoId(String(me), String(other));
  const arr = conversations.get(id) || [];
  const now = new Date().toISOString();

  let changed = false;
  for (const m of arr) {
    if (m.to === me && !m.readAt && !m.isDeleted) {
      m.readAt = now;
      changed = true;
    }
  }

  if (changed) {
    io.to(`chat:${id}`).emit('messages:read', { reader: me, at: now });
  }

  res.json({ ok:true, readAt: now });
});

app.patch('/api/messages/:mid', (req,res) => {
  const { me, text } = req.body || {};
  const mid = String(req.params.mid || '');
  if (!me || !text) return res.status(400).json({ error:'me and text required' });

  let found = null;
  let key = null;

  for (const [cid, arr] of conversations.entries()) {
    const m = arr.find(x => x.id === mid);
    if (m) {
      found = m;
      key = cid;
      break;
    }
  }

  if (!found) return res.status(404).json({ error:'Сообщение не найдено' });
  if (found.from !== me) return res.status(403).json({ error:'Нельзя менять чужое сообщение' });
  if (found.isDeleted) return res.status(400).json({ error:'Сообщение уже удалено' });

  found.text = String(text).slice(0, 4000);
  found.updatedAt = new Date().toISOString();

  io.to(`chat:${key}`).emit('message:update', found);
  res.json({ ok:true, message: found });
});

app.delete('/api/messages/:mid', (req,res) => {
  const me = String(req.body.me || req.query.me || '');
  const mid = String(req.params.mid || '');
  if (!me) return res.status(400).json({ error:'me required' });

  let found = null;
  let key = null;

  for (const [cid, arr] of conversations.entries()) {
    const m = arr.find(x => x.id === mid);
    if (m) {
      found = m;
      key = cid;
      break;
    }
  }

  if (!found) return res.status(404).json({ error:'Сообщение не найдено' });
  if (found.from !== me) return res.status(403).json({ error:'Нельзя удалить чужое сообщение' });

  found.isDeleted = true;
  found.text = 'Сообщение удалено';
  found.updatedAt = new Date().toISOString();

  io.to(`chat:${key}`).emit('message:update', found);
  res.json({ ok:true });
});

io.on('connection', (socket) => {
  socket.on('auth', ({ userId }) => {
    const user = users.get(userId);
    if (!user) return;
    user.online = true;
    user.socketId = socket.id;
    socket.userId = userId;
    socket.join(`user:${userId}`);
    socket.emit('auth_ok', publicUser(user));
    io.emit('presence', publicUser(user));
  });

  socket.on('join_chat', ({ me, other }) => {
    if (!me || !other) return;
    socket.join(`chat:${convoId(me, other)}`);
  });

  socket.on('typing', ({ me, other, isTyping }) => {
    if (!me || !other) return;
    socket.to(`chat:${convoId(me, other)}`).emit('typing', { from:me, isTyping:!!isTyping });
  });

  socket.on('message', async ({ from, to, text }) => {
    if (!from || !to || !text) return;
    const msg = {
      id: makeId(),
      from,
      to,
      text:String(text).slice(0, 4000),
      time:new Date().toISOString(),
      updatedAt:null,
      isDeleted:false,
      readAt:null
    };

    const id = convoId(from, to);
    const arr = conversations.get(id) || [];
    arr.push(msg);
    conversations.set(id, arr);

    io.to(`chat:${id}`).emit('message', msg);
    io.to(`user:${from}`).emit('chats:update');
    io.to(`user:${to}`).emit('chats:update');

    try {
      const sender = users.get(from);
      const target = users.get(to);
      if (sender && target?.email) {
        await sendIncomingMessageEmail({
          senderName: sender.name,
          senderNick: sender.nick,
          targetEmail: target.email,
          text: msg.text
        });
      }
    } catch (err) {
      console.error('Message email send failed:', err.message);
    }
  });

  socket.on('call:offer', async ({ from, to, offer, isVideo }) => {
    const caller = users.get(from);
    const target = users.get(to);
    if (!target?.socketId) return;

    io.to(target.socketId).emit('call:offer', { from, offer, isVideo:!!isVideo });

    try {
      if (caller && target?.email) {
        await sendIncomingCallEmail({
          callerName: caller.name,
          callerNick: caller.nick,
          targetEmail: target.email,
          isVideo: !!isVideo
        });
      }
    } catch (err) {
      console.error('Email send failed:', err.message);
    }
  });

  socket.on('call:answer', ({ from, to, answer }) => {
    const target = users.get(to);
    if (!target?.socketId) return;
    io.to(target.socketId).emit('call:answer', { from, answer });
  });

  socket.on('call:ice', ({ from, to, candidate }) => {
    const target = users.get(to);
    if (!target?.socketId) return;
    io.to(target.socketId).emit('call:ice', { from, candidate });
  });

  socket.on('call:end', ({ from, to }) => {
    const target = users.get(to);
    if (!target?.socketId) return;
    io.to(target.socketId).emit('call:end', { from });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.userId);
    if (user) {
      user.online = false;
      user.socketId = null;
      user.lastSeenAt = new Date().toISOString();
      io.emit('presence', publicUser(user));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('WaveTalk big server on http://localhost:' + PORT));
