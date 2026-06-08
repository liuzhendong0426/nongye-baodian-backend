require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);

const PORT = process.env.PORT || 3000;
const SERVER_TOKEN = process.env.SERVER_TOKEN || '';

const pageShell = (title, body) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - 种植宝典</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;max-width:760px;margin:0 auto;padding:32px 20px;color:#26342a;line-height:1.8;background:#f7faf6}
    main{background:#fff;border:1px solid #e5efe4;border-radius:12px;padding:28px;box-shadow:0 8px 24px rgba(35,84,45,.06)}
    h1{font-size:26px;color:#247a3b;margin:0 0 8px}
    h2{font-size:18px;color:#247a3b;margin:28px 0 8px}
    p,li{font-size:15px}
    .date{color:#758275;font-size:13px;margin-bottom:24px}
  </style>
</head>
<body><main>${body}</main></body>
</html>`;

const privacyHtml = pageShell('隐私政策', `
  <h1>种植宝典隐私政策</h1>
  <p class="date">最后更新日期：2026年6月9日</p>
  <p>种植宝典重视您的隐私。本政策说明我们如何访问、使用、处理和保护与应用功能相关的数据。</p>
  <h2>我们访问和处理的数据</h2>
  <ul>
    <li>相机、相册与照片：用于拍照识病和专家问诊。照片会通过后端代理临时发送给 AI 服务提供方进行识别处理。</li>
    <li>位置信息：用于通过后端代理查询当地天气和生成农事建议。</li>
    <li>麦克风与语音识别：仅在您点击语音输入时请求权限，用于把语音转为文字。</li>
    <li>本地数据：昵称、识别记录、记账数据、缓存等主要保存在您的设备本地。</li>
  </ul>
  <h2>第三方服务</h2>
  <p>应用会使用和风天气、智谱 AI、DeepSeek、硅基流动、Apple 语音识别等服务提供天气、AI 识别、AI 对话和语音转文字能力。第三方服务仅处理提供功能所需的数据。</p>
  <h2>数据保留与删除</h2>
  <p>本地数据可在应用内清除，或通过卸载应用删除。服务端仅为提供功能临时处理请求数据，不用于广告画像。如需咨询隐私问题或请求协助删除服务端临时数据，可通过客服邮箱联系我们。</p>
  <h2>联系我们</h2>
  <p>如需咨询隐私问题或请求协助删除数据，请通过客服邮箱 164216265@qq.com 联系我们。</p>
`);

const termsHtml = pageShell('用户协议', `
  <h1>种植宝典用户协议</h1>
  <p class="date">最后更新日期：2026年6月8日</p>
  <p>欢迎使用种植宝典。使用本应用即表示您同意遵守本协议。</p>
  <h2>服务说明</h2>
  <p>种植宝典提供农作物病虫害 AI 识别、AI 问答、天气农事建议、专家问诊、种植百科、农资计算、视频课程、农业记账等工具。</p>
  <h2>重要免责声明</h2>
  <ul>
    <li>AI 识别、农事建议和用药建议仅供参考，不构成专业农技指导。</li>
    <li>农药、肥料使用请严格按产品说明书和当地农技站建议执行。</li>
    <li>天气与第三方数据可能存在延迟或误差，请结合当地实际情况判断。</li>
  </ul>
  <h2>用户责任</h2>
  <p>您不得利用本应用从事违法违规活动，不得反向工程、破解或恶意滥用服务。</p>
  <h2>服务变更</h2>
  <p>我们可能根据功能、安全、合规要求更新服务和协议内容，并在应用或网页中公示。</p>
`);

app.get('/privacy', (_req, res) => res.type('html').send(privacyHtml));
app.get('/terms', (_req, res) => res.type('html').send(termsHtml));

// ========== 认证中间件 ==========
function auth(req, res, next) {
  const token = req.headers['x-server-token'];
  if (!SERVER_TOKEN) {
    return res.status(503).json({ error: '服务端令牌未配置', code: 'SERVER_TOKEN_MISSING' });
  }
  if (token !== SERVER_TOKEN) {
    return res.status(401).json({ error: '未授权访问', code: 'UNAUTHORIZED' });
  }
  next();
}

// ========== OpenAI 兼容 API 调用 ==========
async function callAI({ url, apiKey, model, messages, maxTokens = 2048, temperature = 0.01 }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI 服务异常 (${res.status}): ${text.substring(0, 200)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回数据为空');
  return content;
}

// ========== 视觉识别提示词 ==========
const VISION_PROMPT = `你是一位严谨、负责的农业植保专家，专门为中国农民服务。你的回答必须用农民听得懂的大白话。

核心原则：
1. 无法确定时必须在 confidence 设为"低"，在 note 中说明原因
2. 绝不杜撰病害名称或治疗方案
3. 只有 confidence 为"高"才推荐具体药品
4. 每个药品必须给出"safetyInterval"（安全间隔期，即打完药后多少天才能采摘/食用），这关乎食品安全
5. 必须给出"organicAlternatives"（不用农药的土办法/生物防治方案），至少1条
6. 必须给出"cheapestOption"（最省钱的有效方案）
7. 用药说明中避免专业术语，比如不要说"稀释800倍"，要说"一盖药兑一喷雾器水"

返回 JSON 格式：
{
  "crop": "作物名称",
  "disease": "病害名称",
  "type": "病害|虫害|缺素|正常|无法确定",
  "confidence": "高|中|低",
  "note": "说明",
  "symptoms": ["症状1"],
  "cause": "病因",
  "treatment": [{"step": 1, "content": "步骤"}],
  "medicine": [{"name": "药品", "usage": "用法", "safetyInterval": "7天"}],
  "prevention": ["措施"],
  "tips": "小贴士",
  "organicAlternatives": "土办法：...",
  "cheapestOption": "最省钱办法：..."
}

如果照片无关农业，返回 {"error": true, "message": "请拍摄农作物照片"}`;

// 获取可用的视觉模型 providers
function getVisionProviders() {
  const p = [];
  if (process.env.ZHIPU_API_KEY && !process.env.ZHIPU_API_KEY.startsWith('YOUR_')) {
    p.push({ name: '智谱', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', apiKey: process.env.ZHIPU_API_KEY, model: 'glm-4v-flash' });
  }
  if (process.env.SILICONFLOW_API_KEY && !process.env.SILICONFLOW_API_KEY.startsWith('YOUR_')) {
    p.push({ name: '硅基流动', url: 'https://api.siliconflow.cn/v1/chat/completions', apiKey: process.env.SILICONFLOW_API_KEY, model: 'Qwen/Qwen2-VL-7B-Instruct' });
  }
  if (process.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_API_KEY.startsWith('YOUR_')) {
    p.push({ name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', apiKey: process.env.DEEPSEEK_API_KEY, model: 'deepseek-chat' });
  }
  return p;
}

function getChatProviders() {
  const p = [];
  if (process.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_API_KEY.startsWith('YOUR_')) {
    p.push({ name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', apiKey: process.env.DEEPSEEK_API_KEY, model: 'deepseek-chat' });
  }
  if (process.env.SILICONFLOW_API_KEY && !process.env.SILICONFLOW_API_KEY.startsWith('YOUR_')) {
    p.push({ name: '硅基流动', url: 'https://api.siliconflow.cn/v1/chat/completions', apiKey: process.env.SILICONFLOW_API_KEY, model: 'deepseek-ai/DeepSeek-V3' });
  }
  return p;
}

// ========== POST /api/vision/recognize ==========
app.post('/api/vision/recognize', auth, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: '缺少图片数据', code: 'BAD_REQUEST' });

    const messages = [
      { role: 'system', content: VISION_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: '请诊断这张农作物照片' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
      ]}
    ];

    const providers = getVisionProviders();
    if (!providers.length) return res.status(503).json({ error: 'AI 服务未配置', code: 'NO_PROVIDER' });

    let lastError = null;
    for (const p of providers) {
      try {
        const raw = await callAI({ url: p.url, apiKey: p.apiKey, model: p.model, messages });
        return res.json({ success: true, provider: p.name, raw });
      } catch (e) {
        lastError = e.message;
        console.error(`[${p.name}] 识别失败:`, e.message);
      }
    }
    res.status(502).json({ error: lastError || 'AI 服务调用失败', code: 'PROVIDER_ERROR' });
  } catch (e) {
    console.error('[vision]', e);
    res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL' });
  }
});

// ========== POST /api/ai/chat ==========
app.post('/api/ai/chat', auth, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: '缺少消息数据', code: 'BAD_REQUEST' });

    const systemMsg = { role: 'system', content: '你是农业助手"种植宝典"的 AI，用中国农民听得懂的大白话回答问题。回答要简洁、实用、接地气。' };
    const providers = getChatProviders();
    if (!providers.length) return res.status(503).json({ error: 'AI 服务未配置', code: 'NO_PROVIDER' });

    let lastError = null;
    for (const p of providers) {
      try {
        const content = await callAI({ url: p.url, apiKey: p.apiKey, model: p.model, messages: [systemMsg, ...messages], temperature: 0.7 });
        return res.json({ success: true, provider: p.name, content });
      } catch (e) {
        lastError = e.message;
        console.error(`[${p.name}] 对话失败:`, e.message);
      }
    }
    res.status(502).json({ error: lastError || 'AI 服务调用失败', code: 'PROVIDER_ERROR' });
  } catch (e) {
    console.error('[chat]', e);
    res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL' });
  }
});

// ========== POST /api/expert/consult ==========
app.post('/api/expert/consult', auth, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: '缺少消息数据', code: 'BAD_REQUEST' });

    const systemMsg = { role: 'system', content: '你是一位资深农业专家，专门为农民提供种植、病虫害防治、施肥等专业咨询。用大白话回答，给出具体可行的建议。' };
    const providers = getChatProviders();
    if (!providers.length) return res.status(503).json({ error: 'AI 服务未配置', code: 'NO_PROVIDER' });

    let lastError = null;
    for (const p of providers) {
      try {
        const content = await callAI({ url: p.url, apiKey: p.apiKey, model: p.model, messages: [systemMsg, ...messages], temperature: 0.7 });
        return res.json({ success: true, provider: p.name, content });
      } catch (e) {
        lastError = e.message;
      }
    }
    res.status(502).json({ error: lastError || 'AI 服务调用失败', code: 'PROVIDER_ERROR' });
  } catch (e) {
    console.error('[expert]', e);
    res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL' });
  }
});

// ========== GET /api/weather/now ==========
app.get('/api/weather/now', auth, async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: '缺少经纬度', code: 'BAD_REQUEST' });

    const apiKey = process.env.QWEATHER_API_KEY;
    if (!apiKey || apiKey.startsWith('YOUR_')) return res.status(503).json({ error: '天气服务未配置', code: 'NO_PROVIDER' });

    const url = `https://n32k5pt6nn.re.qweatherapi.com/v7/weather/now?location=${lon},${lat}&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`天气服务异常 (${resp.status})`);

    const body = await resp.json();
    const now = body.now || {};
    res.json({ success: true, data: {
      temp: now.temp || '',
      feelsLike: now.feelsLike || '',
      humidity: now.humidity || '',
      windSpeed: now.windSpeed || '',
      windDir: now.windDir || '',
      text: now.text || '',
      icon: now.icon || '',
    }});
  } catch (e) {
    console.error('[weather/now]', e.message);
    res.status(502).json({ error: '天气服务暂不可用', code: 'PROVIDER_ERROR' });
  }
});

// ========== GET /api/weather/indices ==========
app.get('/api/weather/indices', auth, async (req, res) => {
  try {
    const { lat, lon, type = '0' } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: '缺少经纬度', code: 'BAD_REQUEST' });

    const apiKey = process.env.QWEATHER_API_KEY;
    if (!apiKey || apiKey.startsWith('YOUR_')) return res.status(503).json({ error: '天气服务未配置', code: 'NO_PROVIDER' });

    const url = `https://n32k5pt6nn.re.qweatherapi.com/v7/indices/1d?location=${lon},${lat}&key=${apiKey}&type=${type}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`天气服务异常 (${resp.status})`);

    const data = await resp.json();
    res.json({ success: true, data: data.daily || data });
  } catch (e) {
    console.error('[weather/indices]', e.message);
    res.status(502).json({ error: '天气指数暂不可用', code: 'PROVIDER_ERROR' });
  }
});

// ========== GET /api/weather/geo ==========
app.get('/api/weather/geo', auth, async (req, res) => {
  try {
    const { city } = req.query;
    if (!city) return res.status(400).json({ error: '缺少城市名', code: 'BAD_REQUEST' });

    const apiKey = process.env.QWEATHER_API_KEY;
    if (!apiKey || apiKey.startsWith('YOUR_')) return res.status(503).json({ error: '天气服务未配置', code: 'NO_PROVIDER' });

    const url = `https://n32k5pt6nn.re.qweatherapi.com/geo/v2/city/lookup?location=${encodeURIComponent(city)}&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`地理服务异常 (${resp.status})`);

    const data = await resp.json();
    res.json({ success: true, data: data.location || [] });
  } catch (e) {
    console.error('[weather/geo]', e.message);
    res.status(502).json({ error: '地理查询暂不可用', code: 'PROVIDER_ERROR' });
  }
});

// ========== 百科数据 ==========
const encyclopediaData = require('../encyclopedia.json');

app.get('/api/encyclopedia', auth, (req, res) => {
  const { category } = req.query;
  let data = encyclopediaData;
  if (category && category !== 'all') {
    data = data.filter(e => e.category === category);
  }
  res.json({ success: true, data, total: data.length });
});

// ========== GET /health ==========
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Vercel serverless: no listen()
module.exports = app;
