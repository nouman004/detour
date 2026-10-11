const http = require('http');
const fs = require('fs');
const path = require('path');

const { GEMINI_API_KEY, OPENROUTER_API_KEY, PLACES_API_KEY } = process.env;
const MODEL = process.env.GEMMA_MODEL || 'gemma-4-31b-it';
const PORT = process.env.PORT || 3000;
const page = fs.readFileSync(path.join(__dirname, 'index.html'));

// very small per-IP rate limit to protect the free API quota
const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); hits.set(ip, list);
  return list.length > 12;
}

const tidy = t => (t || '').replace(/\s+/g, ' ').trim();
const cache = new Map(); // remembers real AI nudges so repeat requests are instant

async function callOpenRouter(model, prompt, maxTokens, signal) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENROUTER_API_KEY, 'X-Title': 'Detour' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.7 }),
    signal
  });
  const j = await r.json().catch(() => ({}));
  const text = tidy(j.choices?.[0]?.message?.content);
  if (!r.ok || !text) throw new Error(`openrouter ${model}: ${r.status} ${JSON.stringify(j.error || 'no text').slice(0, 140)}`);
  return text;
}

async function callGoogle(model, prompt, maxTokens, signal) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    }),
    signal
  });
  const j = await r.json().catch(() => ({}));
  const parts = j.candidates?.[0]?.content?.parts || [];
  const text = tidy(parts.filter(p => !p.thought).map(p => p.text || '').join(''));
  if (!r.ok || !text) throw new Error(`google ${model}: ${r.status} ${JSON.stringify(j.error || 'no text').slice(0, 140)}`);
  return text;
}

// Gemma only, but through two independent routes (OpenRouter and Google AI Studio).
// Each wave sends the routes at the same time and uses whichever answers first; wave 2 tries the second Gemma model.
async function llm(prompt, maxTokens = 100) {
  const deadline = Date.now() + 35000;
  const gModels = [MODEL, 'gemma-4-26b-a4b-it'].filter((m, i, arr) => arr.indexOf(m) === i);
  const orModels = (process.env.OPENROUTER_MODELS || 'google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free').split(',').map(m => m.trim());
  const waves = [0, 1].map(i => [
    OPENROUTER_API_KEY && ['openrouter', orModels[i]],
    GEMINI_API_KEY && gModels[i] && ['google', gModels[i]]
  ].filter(Boolean));
  for (const wave of waves) {
    const left = deadline - Date.now();
    if (!wave.length || left < 4000) continue;
    const ac = new AbortController();
    let done = false;
    const timer = setTimeout(() => ac.abort(), Math.min(20000, left));
    try {
      const won = await Promise.any(wave.map(([prov, model]) =>
        (prov === 'openrouter' ? callOpenRouter : callGoogle)(model, prompt, Math.max(maxTokens, 1500), ac.signal)
          .then(t => ({ t, via: prov + ' ' + model }))
          .catch(e => { if (!done) console.error(e.name === 'AbortError' ? `${prov} ${model}: timed out` : e.message); throw e; })));
      done = true;
      console.log('Answered by', won.via);
      return won.t;
    } catch (e) { /* every route in this wave failed, try the next wave */ }
    finally { clearTimeout(timer); ac.abort(); }
  }
  return '';
}

async function reviews(name, lat, lon) {
  if (!PLACES_API_KEY) return null;
  const s = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_API_KEY, 'X-Goog-FieldMask': 'places.id' },
    body: JSON.stringify({
      textQuery: name, maxResultCount: 1,
      locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: 200 } }
    })
  });
  const p = (await s.json()).places?.[0];
  if (!p) return null;
  const d = await fetch('https://places.googleapis.com/v1/places/' + p.id, {
    headers: { 'X-Goog-Api-Key': PLACES_API_KEY, 'X-Goog-FieldMask': 'rating,userRatingCount,reviews' }
  });
  const j = await d.json();
  const text = (j.reviews || []).map(r => r.text?.text || '').filter(Boolean).join('\n---\n');
  return text ? { text, rating: j.rating, count: j.userRatingCount } : null;
}

const fallbackNudge = (name, extra, where = 'passes') => {
  const e = Math.round(Number(extra) || 0);
  return name
    ? `Take the long way today: ${e > 1 ? `it adds about ${e} minutes and ` : ''}it ${where} ${name}. Notice something you have never seen.`
    : 'Same destination, new streets. Take the long way today and notice something you have never seen.';
};
const bad = t => !t || t.length < 15 || t.length > 280 || /[\[\]]/.test(t);

async function makeText({ bakery, lat, lon, extra, dist }) {
  const name = String(bakery || '').slice(0, 80);
  const dm = Number(dist);
  const where = dm > 150 ? `is a short walk (about ${Math.round(dm)} metres) from` : 'passes right by';
  const ck = name + '|' + Math.round(Number(extra) || 0) + '|' + where;
  const nudgeP = cache.has(ck) ? Promise.resolve(cache.get(ck)) : llm(
    `Write one or two short, warm sentences encouraging someone to take a slightly different route today` +
    ` that is ${Number(extra) || 0} minutes longer and ${where} a bakery${name ? ` called ${name}` : ''}. ` +
    `Plain text only: no emojis, no brackets, no quotation marks, no markdown, no placeholders. Output only the sentences.`, 80
  ).catch(() => '');
  const revP = name ? reviews(name, lat, lon).catch(() => null) : Promise.resolve(null);
  const [nudgeRaw, rev] = await Promise.all([nudgeP, revP]);
  if (!bad(nudgeRaw) && !cache.has(ck)) { if (cache.size > 200) cache.clear(); cache.set(ck, nudgeRaw); }
  let dish = '';
  if (rev) {
    const d = await llm(
      'Below are customer reviews of a bakery. Name the single food item mentioned most positively and give a short reason, ' +
      'in one sentence. If no food item is clearly praised, reply with exactly NONE.\n\nReviews:\n' + rev.text.slice(0, 3000), 80
    ).catch(() => '');
    if (d && !/^NONE\b/i.test(d) && d.length < 300) dish = `Most praised in Google reviews (${rev.rating}/5 from ${rev.count} ratings): ${d}`;
  }
  return { nudge: bad(nudgeRaw) ? fallbackNudge(name, extra, where) : nudgeRaw, dish, ai: !bad(nudgeRaw) };
}

http.createServer(async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page);
  }
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'POST' && req.url === '/api/text') {
    if (limited(ip)) { res.writeHead(429); return res.end('{}'); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5000) req.destroy(); });
    req.on('end', async () => {
      try {
        const out = await makeText(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
      } catch (e) { console.error(e); res.writeHead(500); res.end('{}'); }
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('Detour running on port ' + PORT));