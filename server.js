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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  return { id:u.id, name:u.name, nick:u.nick, online:!!u.online, email:u.email || '' };
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
    online:false,
    socketId:null
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

app.get('/api/messages', (req,res) => {
  const { me, other } = req.query;
  if (!me || !other) return res.status(400).json({ error:'me and other required' });
  res.json({ ok:true, messages: conversations.get(convoId(String(me), String(other))) || [] });
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
    const msg = { from, to, text:String(text).slice(0, 4000), time:new Date().toISOString() };
    const id = convoId(from, to);
    const arr = conversations.get(id) || [];
    arr.push(msg);
    conversations.set(id, arr);
    io.to(`chat:${id}`).emit('message', msg);

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
      io.emit('presence', publicUser(user));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('WaveTalk with calls + email on http://localhost:' + PORT));
