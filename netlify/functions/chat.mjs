// Серверная функция Netlify: отвечает сайту через Netlify AI Gateway (без ключей).
// Если задан GEMINI_API_KEY, он используется как запасной вариант.

const SYSTEM_CHAT = `Ты — ИИ-помощник в чате учебного сайта TeenSupport: анонимная психологическая поддержка подростков 13–19 лет в Казахстане.
Правила:
- Отвечай на том языке, на котором написано последнее сообщение (русский или казахский). Обращайся на «ты».
- Тон тёплый, спокойный, без осуждения и нравоучений. 2–4 коротких предложения, без списков, заголовков и markdown.
- Сначала покажи, что понял чувства человека, потом задай один мягкий уточняющий вопрос или предложи один небольшой шаг.
- Не ставь диагнозы, не советуй лекарства. Не притворяйся человеком или психологом: если спросят, честно скажи, что ты ИИ.
- Не проси имя, школу, адрес, телефон и другие личные данные.
- Если есть мысли о смерти, самоповреждении, насилии, угрозе жизни — мягко и прямо попроси позвонить прямо сейчас на 150 (телефон доверия для детей и молодёжи, бесплатно, круглосуточно) или 112 и рассказать взрослому, которому доверяет.
- Если ситуация требует долгой работы, можно предложить консультацию специалиста TeenSupport (раздел «Специалисты»).
- Если вопрос не про чувства и жизнь подростка, мягко верни разговор к теме поддержки.`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const clip = (s, n) => String(s ?? "").slice(0, n);

// Основной путь: Netlify AI Gateway (ключ не нужен, Netlify подставляет его сам).
// Запасной путь: собственный ключ Gemini, если шлюз недоступен.
async function claude(system, contents, wantJson) {
  const url = process.env.NETLIFY_AI_GATEWAY_URL;
  const key = process.env.NETLIFY_AI_GATEWAY_KEY;
  if (!url || !key) return { status: 503 };
  const messages = contents.map((c) => ({
    role: c.role === "model" ? "assistant" : "user",
    content: c.parts.map((p) => p.text).join("\n"),
  }));
  const r = await fetch(`${url.replace(/\/$/, "")}/anthropic/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "claude-haiku-4-5",
      max_tokens: 600,
      temperature: wantJson ? 0.2 : 0.7,
      system: wantJson ? system + "\nВыведи только JSON без пояснений и без markdown." : system,
      messages,
    }),
  });
  if (r.status === 429) return { status: 429 };
  if (!r.ok) { console.error("ai gateway", r.status, (await r.text()).slice(0, 500)); return { status: 502 }; }
  const data = await r.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return { status: 200, text };
}

async function gemini(key, system, contents, wantJson) {
  const model = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
  const generationConfig = { temperature: wantJson ? 0.2 : 0.7, maxOutputTokens: 600 };
  if (wantJson) generationConfig.responseMimeType = "application/json";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
  });
  if (r.status === 429) return { status: 429 };
  if (!r.ok) { console.error("gemini", r.status, (await r.text()).slice(0, 500)); return { status: 502 }; }
  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  return { status: 200, text };
}

async function ask(system, contents, wantJson) {
  const out = await claude(system, contents, wantJson);
  if (out.status === 200) return out;
  const key = process.env.GEMINI_API_KEY;
  if (key) {
    const alt = await gemini(key, system, contents, wantJson);
    if (alt.status === 200) return alt;
    return out.status === 503 ? alt : out;
  }
  return out;
}

export default async (req) => {
  const available = Boolean(process.env.NETLIFY_AI_GATEWAY_KEY || process.env.GEMINI_API_KEY);
  if (req.method === "GET") return json({ ai: available });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!available) return json({ error: "no_key" }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  if (body.mode === "chat") {
    const turns = (Array.isArray(body.messages) ? body.messages : [])
      .slice(-16)
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: clip(m.content, 800) }] }));
    while (turns.length && turns[0].role !== "user") turns.shift();
    if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "bad_turns" }, 400);
    const out = await ask(SYSTEM_CHAT, turns, false);
    if (out.status !== 200) return json({ error: "upstream" }, out.status);
    return json({ text: out.text || "" });
  }

  if (body.mode === "match") {
    const specs = (Array.isArray(body.specs) ? body.specs : []).slice(0, 20).map((s, i) => ({
      i, name: clip(s.name, 60), role: clip(s.role, 60), topics: (s.topics || []).slice(0, 6).map((t) => clip(t, 40)),
      languages: (s.languages || []).slice(0, 3).map((t) => clip(t, 10)), about: clip(s.about, 200),
    }));
    const lang = body.lang === "kk" ? "казахском" : "русском";
    const system = `Ты подбираешь психолога для подростка на сайте TeenSupport. Отвечай только JSON вида {"picks":[{"i":0,"why":"..."}],"urgent":false}. Выбери 1 или 2 самых подходящих специалиста из списка. Поле why — одно короткое тёплое предложение на ${lang} языке, на «ты». urgent=true, если в запросе есть мысли о смерти, самоповреждение, насилие или угроза жизни.`;
    const prompt = `Специалисты: ${JSON.stringify(specs)}\nЗапрос подростка: """${clip(body.query, 500)}"""`;
    const out = await ask(system, [{ role: "user", parts: [{ text: prompt }] }], true);
    if (out.status !== 200) return json({ error: "upstream" }, out.status);
    let parsed = null;
    try { parsed = JSON.parse(out.text); } catch { const m = out.text.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }
    if (!parsed) return json({ error: "bad_model_json" }, 502);
    return json(parsed);
  }

  return json({ error: "bad_mode" }, 400);
};

export const config = { path: "/api/chat" };
