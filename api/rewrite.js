// Vercel serverless function: POST /api/rewrite
// Rewrites the user's CURRENT caption draft following their latest instructions.
// Setup: in Vercel -> Project -> Settings -> Environment Variables add ANTHROPIC_API_KEY
// (optional: ANTHROPIC_MODEL, default below). Requires Node 18+ (global fetch).

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_FIELD = 6000;

const SYSTEM = `You are the caption editor for ForeverAdventurer, a travel creator over 50 who writes warm, cheeky, authentic British-English Instagram Reel captions.
You REWRITE the person's current caption draft. Follow these rules strictly:
1. The CURRENT DRAFT is the working draft and the source of truth. Do not restart from the original fields. Keep everything the person wrote unless an instruction tells you to change or remove it. Their manual edits always win.
2. Apply the INSTRUCTIONS exactly. If tone or length settings are given, apply them too. If instructions conflict with the defaults, the instructions win.
3. Never invent facts. Do not add prices, addresses, opening times, awards (including Michelin recognition), "free" claims, or any other detail that is not in the draft, the facts, the badge or the instructions. Keep every price, address, place name and number exactly as supplied unless told to change it.
4. If the person asks for something that would need a fact you don't have, do NOT make it up: leave it out and mention it in "notes".
5. Do not bring back anything that is present in the "last generated" version but missing from the current draft: the person removed it on purpose.
6. If you change a fact because the instructions say so (new location, new price), use the new value everywhere.
7. The pop-up badge is a visual overlay shown separately. Mention it in the caption ONLY if includeInCaption is true. Never alter the badge itself.
8. Preserve hashtags, signature taglines and emoji style unless told otherwise. Use British English.
9. If only one detail changed, keep the rest of the draft as it is.
Reply with JSON only, no markdown fences: {"caption": "<the full rewritten caption>", "notes": ["<short note about anything uncertain, omitted or needing a check>"]}. "notes" may be empty.`;

function clip(v, n = MAX_FIELD) { return String(v == null ? "" : v).slice(0, n); }

function buildUserMessage(p) {
  const f = p.facts || {}, b = p.badge || {};
  return [
    `<current_draft>\n${clip(p.currentCaption)}\n</current_draft>`,
    `<last_generated_version>\n${clip(p.lastGeneratedCaption)}\n</last_generated_version>`,
    `<instructions>\n${clip(p.instructions, 2000) || "(none: apply the tone/length settings only)"}\n</instructions>`,
    `<settings>\ntone: ${clip(p.tone, 40)}\nlength: ${clip(p.length, 40)}\n</settings>`,
    `<facts_to_keep_accurate>\ndestination: ${clip(f.destination, 300)}\nbudget_win: ${clip(f.budgetWin, 500)}\nobservation: ${clip(f.observation, 500)}\non_screen_hook: ${clip(f.hook, 300)}\nstorytelling_angle: ${clip(f.angle, 100)}\nprotected_details (keep exactly): ${(Array.isArray(p.protectedDetails) ? p.protectedDetails : []).slice(0, 30).map(x => clip(x, 80)).join(" | ")}\n</facts_to_keep_accurate>`,
    `<badge>\nenabled: ${!!b.enabled}\nlabel: ${clip(b.label, 80)}\nsupporting_text: ${clip(b.supportingText, 200)}\nincludeInCaption: ${!!b.includeInCaption}\n</badge>`
  ].join("\n\n");
}

function parseModelJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return { caption: cleaned, notes: ["The model didn't return structured output, so its raw reply is shown. Please check it carefully."] };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Use POST." }); }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "The server has no ANTHROPIC_API_KEY set. Add it in your Vercel project settings, then redeploy." });

  let p = req.body;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) { p = null; } }
  if (!p || typeof p.currentCaption !== "string" || !p.currentCaption.trim()) return res.status(400).json({ error: "There is no caption draft to rewrite." });
  if (p.currentCaption.length > MAX_FIELD) return res.status(400).json({ error: "The caption is too long to rewrite (limit 6,000 characters)." });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM, messages: [{ role: "user", content: buildUserMessage(p) }] })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).
