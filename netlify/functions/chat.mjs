// Серверная функция Netlify: прячет ключ Gemini и отвечает сайту.
// Ключ задаётся в Netlify: Site configuration → Environment variables → GEMINI_API_KEY

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

async function gemini(key, system, contents, wantJson) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const generationConfig = { temperature: wantJson ? 0.2 : 0.7, maxOutputTokens: 600 };
  if (wantJson) generationConfig.responseMimeType = "application/json";
  if (model.startsWith("gemini-2.5-flash")) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
  });
  if (r.status === 429) return { status: 429 };
  if (!r.ok) return { status: 502, detail: await r.text() };
  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  return { status: 200, text };
}

export default async (req) => {
  const key = process.env.GEMINI_API_KEY;
  if (req.method === "GET") return json({ ai: Boolean(key) });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!key) return json({ error: "no_key" }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  if (body.mode === "chat") {
    const turns = (Array.isArray(body.messages) ? body.messages : [])
      .slice(-16)
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: clip(m.content, 800) }] }));
    while (turns.length && turns[0].role !== "user") turns.shift();
    if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "bad_turns" }, 400);
    const out = await gemini(key, SYSTEM_CHAT, turns, false);
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
    const out = await gemini(key, system, [{ role: "user", parts: [{ text: prompt }] }], true);
    if (out.status !== 200) return json({ error: "upstream" }, out.status);
    let parsed = null;
    try { parsed = JSON.parse(out.text); } catch { const m = out.text.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }
    if (!parsed) return json({ error: "bad_model_json" }, 502);
    return json(parsed);
  }

  return json({ error: "bad_mode" }, 400);
};

export const config = { path: "/api/chat" };
