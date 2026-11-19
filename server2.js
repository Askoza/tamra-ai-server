/**
 * tamra-ai-proxy (Gemini edition)
 * ----------------
 * سيرفر بسيط (Node.js) يستقبل طلبات الذكاء من تطبيق "تمرة"
 * ويناديها لحساب Google Gemini API (فيه مستوى مجاني فعلي)،
 * بدل ما يحتاج الزائر يفتح الصفحة داخل تطبيق/حساب Claude.
 *
 * تشغيل محلي:
 *   cp .env.example .env   ثم عبّي GEMINI_API_KEY (مجاني من aistudio.google.com/apikey)
 *   npm install
 *   npm start
 *
 * الاستضافة: أي مكان يشغّل Node.js (Render, Railway, Fly.io, VPS...).
 * بعد النشر، خذ رابط السيرفر (مثلاً https://tamra-ai.onrender.com)
 * وحطه في إعدادات تطبيق تمرة تحت "رابط سيرفر الذكاء".
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 8787;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '40', 10);
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('⚠️  GEMINI_API_KEY غير موجود. انسخ .env.example إلى .env وعبّيه (مفتاح مجاني من aistudio.google.com/apikey).');
}

const app = express();
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} | origin=${req.headers.origin || 'none'}`); next(); });
app.use(express.json({ limit: '15mb' })); // الصور base64 تحتاج حجم أكبر من الافتراضي
app.use(cors({
  origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map(s => s.trim()),
}));

// ---------- حماية بسيطة من الاستهلاك الزايد (rate limit لكل IP) ----------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count++;
  return rec.count > RATE_LIMIT_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now - rec.start > RATE_WINDOW_MS) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL }));

// ---------- نقطة النهاية الرئيسية ----------
// body: { input: string | [{role,content}], json?: boolean, images?: [{data, mediaType}], maxTokens?: number }
app.post('/api/sample', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: { code: 'rate_limited', message: 'طلبات كثيرة، حاول بعد شوي.' } });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: { code: 'sampling_disabled', message: 'السيرفر ما مُعد بمفتاح API.' } });
  }

  try {
    const { input, json, images, maxTokens } = req.body || {};
    if (!input || (typeof input !== 'string' && !Array.isArray(input))) {
      return res.status(400).json({ error: { code: 'invalid_request', message: 'input مفقود أو غير صالح.' } });
    }

    // ابنِ contents بصيغة Gemini
    let contents;
    if (typeof input === 'string') {
      const parts = [{ text: input }];
      if (Array.isArray(images)) {
        for (const img of images.slice(0, 5)) {
          if (!img || !img.data) continue;
          parts.push({ inlineData: { mimeType: img.mediaType || 'image/jpeg', data: img.data } });
        }
      }
      contents = [{ role: 'user', parts }];
    } else {
      contents = input.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      }));
    }

    const generationConfig = {
      maxOutputTokens: Math.min(Math.max(parseInt(maxTokens || 1500, 10), 64), 4096),
    };
    if (json) generationConfig.responseMimeType = 'application/json';

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig }),
    });
    const data = await r.json();

    if (!r.ok) {
      const msg = data?.error?.message || 'خطأ من Gemini';
      const status = data?.error?.code || r.status;
      console.error(`Gemini error [HTTP ${r.status} / code ${status}]: ${msg}`);
      if (status === 429) return res.status(429).json({ error: { code: 'rate_limited', message: 'تم تجاوز الحد المجاني المؤقت، حاول بعد شوي.' } });
      if (status === 400 && /image|media/i.test(msg)) {
        return res.status(400).json({ error: { code: 'image_rejected', message: 'الصورة مرفوضة أو صيغتها غير مدعومة.' } });
      }
      return res.status(500).json({ error: { code: 'refused', message: msg } });
    }

    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('\n')
      .trim();

    if (!text) {
      console.error('Gemini returned empty text. Raw response:', JSON.stringify(data).slice(0, 1000));
      return res.status(500).json({ error: { code: 'refused', message: 'ما رجع Gemini أي رد (ممكن حظر محتوى).' } });
    }

    if (!json) return res.json({ text });

    const cleaned = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    try {
      const parsed = JSON.parse(cleaned);
      return res.json({ json: parsed });
    } catch (e) {
      return res.status(422).json({ error: { code: 'invalid_json', message: 'الرد ما كان JSON صالح.', text } });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: { code: 'refused', message: e?.message || 'خطأ غير متوقع.' } });
  }
});

app.listen(PORT, () => {
  console.log(`tamra-ai-proxy (Gemini) شغّال على المنفذ ${PORT} (الموديل: ${MODEL})`);
});
