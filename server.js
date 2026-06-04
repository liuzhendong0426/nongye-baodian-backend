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
const SERVER_TOKEN = process.env.SERVER_TOKEN || 'zhongdi-baodian-2024-secure';

// ========== 认证中间件 ==========
function auth(req, res, next) {
  const token = req.headers['x-server-token'];
  if (SERVER_TOKEN && token !== SERVER_TOKEN) {
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

    const url = `https://devapi.qweather.com/v7/weather/now?location=${lon},${lat}&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`天气服务异常 (${resp.status})`);

    const data = await resp.json();
    res.json({ success: true, data });
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

    const url = `https://devapi.qweather.com/v7/indices/1d?location=${lon},${lat}&key=${apiKey}&type=${type}`;
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

    const url = `https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(city)}&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`地理服务异常 (${resp.status})`);

    const data = await resp.json();
    res.json({ success: true, data: data.location || [] });
  } catch (e) {
    console.error('[weather/geo]', e.message);
    res.status(502).json({ error: '地理查询暂不可用', code: 'PROVIDER_ERROR' });
  }
});

// ========== GET /health ==========
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🌾 种植宝典后端已启动: http://localhost:${PORT}`);
  console.log(`   健康检查: http://localhost:${PORT}/health`);
  console.log(`   视觉识别: POST ${PORT}/api/vision/recognize`);
  console.log(`   AI 对话: POST ${PORT}/api/ai/chat`);
  console.log(`   天气: GET ${PORT}/api/weather/now`);
});
