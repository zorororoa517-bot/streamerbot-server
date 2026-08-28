// سيرفر بسيط:
// - يستقبل بيانات من Streamer.bot عن طريق HTTP POST عادي (بدون WebSocket من جهة البوت)
// - يخزن حالة كل يوزر (لفل، ستريك، XP...) بالذاكرة
// - يبث أي تحديث لحظيًا لأي موقع متصل عن طريق WebSocket (نفس فكرة قبل، بس لجهة الموقع)
// - فيه كمان endpoint عادي (GET) يرجع آخر حالة كاملة، تقدر تستخدمه بدل WebSocket لو تبي أبسط
// - يجيب صورة بروفايل اليوزر تلقائيًا من Twitch API (App Access Token) لما يوصل username جديد

const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8080;

// ============ إعدادات Twitch API ============
// نقرأهم من متغيرات البيئة (Environment Variables) بـ Render، ما نحطهم بالكود مباشرة لأسباب أمان
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';

let twitchAppToken = null;
let twitchTokenExpiry = 0;

// نطلب App Access Token جديد من تويتش (يصلح لبيانات عامة فقط، بدون تسجيل دخول أي شخص)
function getTwitchAppToken() {
  return new Promise((resolve, reject) => {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
      reject(new Error('Twitch credentials missing'));
      return;
    }

    // لو التوكن الحالي لسا صالح، نستخدمه بدل ما نطلب وحد جديد
    if (twitchAppToken && Date.now() < twitchTokenExpiry) {
      resolve(twitchAppToken);
      return;
    }

    const postData = `client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`;

    const req = https.request(
      {
        hostname: 'id.twitch.tv',
        path: '/oauth2/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.access_token) {
              twitchAppToken = parsed.access_token;
              // نجدد التوكن قبل انتهائه بدقيقة أمان
              twitchTokenExpiry = Date.now() + (parsed.expires_in - 60) * 1000;
              resolve(twitchAppToken);
            } else {
              reject(new Error('No access_token in response: ' + data));
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// نجيب رابط صورة البروفايل من Twitch API باستخدام login (اسم المستخدم بأحرف صغيرة)
function fetchTwitchAvatar(login) {
  return new Promise(async (resolve) => {
    try {
      const token = await getTwitchAppToken();

      const req = https.request(
        {
          hostname: 'api.twitch.tv',
          path: `/helix/users?login=${encodeURIComponent(login.toLowerCase())}`,
          method: 'GET',
          headers: {
            'Client-Id': TWITCH_CLIENT_ID,
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const avatarUrl = parsed.data && parsed.data[0] ? parsed.data[0].profile_image_url : null;
              resolve(avatarUrl);
            } catch (e) {
              resolve(null);
            }
          });
        }
      );

      req.on('error', () => resolve(null));
      req.end();
    } catch (e) {
      console.log('فشل جلب توكن تويتش:', e.message);
      resolve(null);
    }
  });
}

// ============ تخزين الحالة ============
// كل يوزر مخزن حسب userId (ثابت لا يتغير)، ونحتفظ باسمه الحالي (username) للعرض
// كل سجل: { username, level, streak, shareStreak, xp, avatar, lastUpdated }
const users = {};

function ensureUser(userId, username) {
  if (!users[userId]) {
    users[userId] = {
      username: username || userId,
      level: null,
      streak: null,
      streakBest: null,
      shareStreak: null,
      xp: null,
      avatar: null,
      lastUpdated: null,
    };
  }
  // نحدث الاسم لآخر اسم معروف (حتى لو غيّره الشخص)
  if (username) {
    users[userId].username = username;
  }
  return users[userId];
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
  // يدعم شكلين:
  // 1) { "type": "streak", "userId": "12345", "username": "عبدو", "value": 7 }
  // 2) { "userId": "12345", "username": "عبدو", "streak": 7, "streakBest": 12 }
  if (req.method === 'POST' && req.url === '/api/event') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const event = JSON.parse(body);
        const { type, userId, username, value, avatar, streak, streakBest, shareStreak, level, xp } = event;

        if (!userId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing userId' }));
          return;
        }

        const user = ensureUser(userId, username);

        // الشكل القديم: type + value
        if (type === 'streak') user.streak = value;
        else if (type === 'shareStreak') user.shareStreak = value;
        else if (type === 'level') user.level = value;
        else if (type === 'xp') user.xp = value;

        // الشكل الجديد: حقول مباشرة (يقدر يرسل أكثر من حقل بضربة وحدة)
        if (streak !== undefined) user.streak = streak;
        if (streakBest !== undefined) user.streakBest = streakBest;
        if (shareStreak !== undefined) user.shareStreak = shareStreak;
        if (level !== undefined) user.level = level;
        if (xp !== undefined) user.xp = xp;

        // نحدث الصورة لو وصلت مباشرة من البوت
        if (avatar) user.avatar = avatar;

        user.lastUpdated = new Date().toISOString();

        console.log(`حدث جديد: ${user.username} (${userId}) -> streak=${user.streak}, best=${user.streakBest}`);

        // نبث التحديث فورًا (بدون انتظار الصورة، عشان ما نبطئ الاستجابة)
        broadcastToDashboards({
          type: 'event',
          userId,
          user: users[userId],
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        // لو ما عندنا صورة لهذا اليوزر بعد، نجيبها من Twitch API بالخلفية
        // (بعد الرد، عشان ما نأخر استجابة الطلب الأساسي)
        if (!user.avatar && username) {
          const fetchedAvatar = await fetchTwitchAvatar(username);
          if (fetchedAvatar) {
            user.avatar = fetchedAvatar;
            console.log(`تم جلب صورة ${username}`);
            broadcastToDashboards({
              type: 'event',
              userId,
              user: users[userId],
            });
          }
        }
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
