// سيرفر بسيط:
// - يستقبل بيانات من Streamer.bot عن طريق HTTP POST عادي (بدون WebSocket من جهة البوت)
// - يخزن حالة كل يوزر (لفل، ستريك، XP...) بالذاكرة
// - يبث أي تحديث لحظيًا لأي موقع متصل عن طريق WebSocket (نفس فكرة قبل، بس لجهة الموقع)
// - فيه كمان endpoint عادي (GET) يرجع آخر حالة كاملة، تقدر تستخدمه بدل WebSocket لو تبي أبسط

const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// ============ تخزين الحالة ============
// كل يوزر: { level, streak, shareStreak, xp, lastUpdated }
const users = {};

function ensureUser(name) {
  if (!users[name]) {
    users[name] = {
      level: null,
      streak: null,
      shareStreak: null,
      xp: null,
      lastUpdated: null,
    };
  }
  return users[name];
}

// ============ سيرفر HTTP ============
const httpServer = http.createServer((req, res) => {
  // نفعّل CORS عشان أي موقع يقدر يقرأ البيانات من المتصفح مباشرة
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- استقبال حدث من Streamer.bot ----
  // مثال Body متوقع:
  // { "type": "streak", "username": "عبدو", "value": 7 }
  // { "type": "level", "username": "عبدو", "value": 6 }
  // { "type": "shareStreak", "username": "عبدو", "value": 3 }
  // { "type": "xp", "username": "عبدو", "value": 320 }
  if (req.method === 'POST' && req.url === '/api/event') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        const { type, username, value } = event;

        if (!type || !username || value === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing type/username/value' }));
          return;
        }

        const user = ensureUser(username);

        // نحدث الحقل المناسب بس، بدون ما نلمس باقي البيانات
        if (type === 'streak') user.streak = value;
        else if (type === 'shareStreak') user.shareStreak = value;
        else if (type === 'level') user.level = value;
        else if (type === 'xp') user.xp = value;

        user.lastUpdated = new Date().toISOString();

        console.log(`حدث جديد: ${username} -> ${type} = ${value}`);

        // نبث التحديث لكل المواقع المتصلة عن طريق WebSocket
        broadcastToDashboards({
          type: 'event',
          username,
          eventType: type,
          value,
          user: users[username],
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      }
    });
    return;
  }

  // ---- جلب كل البيانات الحالية (يفيد موقعك يقرأها مباشرة بدون WebSocket لو تبي أبسط) ----
  if (req.method === 'GET' && req.url === '/api/users') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(users, null, 2));
    return;
  }

  // ---- صفحة تأكيد إن السيرفر شغال ----
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Streamer.bot bridge server شغال ✅');
});

// ============ WebSocket لبث التحديثات لحظيًا للموقع ============
const wss = new WebSocketServer({ server: httpServer });
const dashboardClients = new Set();

wss.on('connection', (ws) => {
  dashboardClients.add(ws);
  console.log('داشبورد جديد اتصل. العدد الحالي:', dashboardClients.size);

  // أول ما يتصل، نرسله كل البيانات الحالية
  ws.send(JSON.stringify({ type: 'state', users }));

  ws.on('close', () => {
    dashboardClients.delete(ws);
    console.log('داشبورد قطع الاتصال. العدد الحالي:', dashboardClients.size);
  });

  ws.on('error', (err) => console.error('خطأ WebSocket:', err.message));
});

function broadcastToDashboards(payload) {
  const msg = JSON.stringify(payload);
  for (const client of dashboardClients) {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
}

httpServer.listen(PORT, () => {
  console.log(`السيرفر شغال على البورت ${PORT}`);
  console.log(`Endpoint استقبال الأحداث: POST /api/event`);
  console.log(`Endpoint قراءة كل البيانات: GET /api/users`);
});
