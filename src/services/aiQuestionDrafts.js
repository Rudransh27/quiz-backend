// src/services/aiQuestionDrafts.js
//
// Drafts assessment questions for a module's question bank with Claude, from
// the module's own content (knowledge cards, quiz/code cards, the text of
// HTML modules). Drafts are saved with status "draft": an admin must review
// and approve each one before it can be used in any Pre/Post test.
//
// Note: the module's content is sent to Anthropic's API to do this.
// Configuration: ANTHROPIC_API_KEY (or any credential source the Anthropic SDK
// resolves). Without credentials or the SDK installed, the feature reports
// itself as not set up instead of failing.
const mongoose = require("mongoose");
const Module = require("../models/Module");
const Topic = require("../models/Topic");
const Card = require("../models/Card");
const BankQuestion = require("../models/BankQuestion");
const { readQuizContent } = require("./grading/answerKey");

const MODEL = "claude-opus-5-5";
const MAX_DRAFTS = 15;

class AiDraftError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let client = null;
function getClient() {
  if (client) return client;
  let mod;
  try {
    mod = require("@anthropic-ai/sdk");
  } catch (e) {
    throw new AiDraftError(503, "AI drafting isn't set up on this server yet (Anthropic SDK not installed).");
  }
  const Anthropic = mod.default || mod;
  try {
    client = new Anthropic();
  } catch (e) {
    throw new AiDraftError(503, "AI drafting isn't set up on this server yet (no Anthropic API key).");
  }
  return client;
}
function anthropicModule() {
  try { const m = require("@anthropic-ai/sdk"); return m.default || m; } catch (e) { return null; }
}

const htmlToText = (html) => String(html || "")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, " ")
  .trim();

function cardToText(card) {
  const c = card.content || {};
  const title = c.title ? `${c.title}\n` : "";
  switch (card.card_type) {
    case "knowledge": return `${title}${c.text || ""}`;
    case "quiz": {
      const q = readQuizContent(c);
      return `${title}${c.question || ""}\nOptions: ${q.options.join(" | ")}${q.explanation ? `\nExplanation: ${q.explanation}` : ""}`;
    }
    case "code": return `${title}${c.question || ""}${c.explanation ? `\n${c.explanation}` : ""}`;
    case "html_sandbox": return `${title}${htmlToText(c.htmlSource || c.text)}`;
    default: return title.trim() ? `${title.trim()} (${card.card_type})` : "";
  }
}

// The module's teachable content, in reading order.
async function moduleMaterial(moduleId) {
  const mod = await Module.findById(moduleId, "title description").lean();
  if (!mod) throw new AiDraftError(404, "Module not found.");
  const topics = await Topic.find({ module_id: moduleId }).sort({ topicOrder: 1 }).lean();
  const [direct, topicCards] = await Promise.all([
    Card.find({ module_id: moduleId }).sort({ cardOrder: 1 }).lean(),
    Card.find({ topic_id: { $in: topics.map((t) => t._id) } }).sort({ cardOrder: 1 }).lean(),
  ]);
  const parts = [`# ${mod.title}`, mod.description || ""];
  direct.forEach((c) => parts.push(cardToText(c)));
  topics.forEach((t) => {
    parts.push(`## ${t.title}`);
    topicCards.filter((c) => String(c.topic_id) === String(t._id)).forEach((c) => parts.push(cardToText(c)));
  });
  const text = parts.filter((p) => p && p.trim()).join("\n\n");
  return { module: mod, text };
}

const SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correctIndex: { type: "integer" },
          explanation: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
        },
        required: ["question", "options", "correctIndex", "explanation", "difficulty"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

const SYSTEM = `You write assessment questions for an internal corporate learning platform (IRIS Orbit, a regulatory-reporting software company).
The questions measure whether an employee understood one learning module. They are used in a Pre-check (before the module) and a Post-check (after it), so they must test the module's actual ideas, not trivia about wording.

Write multiple-choice questions that:
- are answerable from the module material alone, and test understanding or application, not recall of exact phrases
- have exactly 4 options, one clearly correct, with plausible distractors of similar length and style (no "all of the above" / "none of the above")
- vary where the correct answer sits
- carry a one-sentence explanation of why the correct option is right
- are labelled easy (a key fact), medium (understanding a concept), or hard (applying it to a realistic situation)
- do not repeat or closely paraphrase any of the existing questions listed`;

const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

async function draftQuestions(moduleId, { count = 6, userId } = {}) {
  const n = Math.min(MAX_DRAFTS, Math.max(1, Number(count) || 6));
  const { module, text } = await moduleMaterial(moduleId);
  if (text.length < 200) throw new AiDraftError(400, "This module doesn't have enough written content to draft questions from.");

  const existing = await BankQuestion.find({ moduleId, status: { $ne: "retired" } }, "question").lean();
  const anthropic = getClient();
  const AnthropicSdk = anthropicModule();

  let response;
  try {
    response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `<module>\n${text}\n</module>\n\n<existing_questions>\n${existing.map((q) => `- ${q.question}`).join("\n") || "(none)"}\n</existing_questions>\n\nWrite ${n} new questions for the module "${module.title}", with a mix of difficulties (roughly a third each).`,
      }],
    });
  } catch (err) {
    if (AnthropicSdk && err instanceof AnthropicSdk.AuthenticationError) throw new AiDraftError(503, "AI drafting isn't set up on this server yet (no valid Anthropic API key).");
    if (AnthropicSdk && err instanceof AnthropicSdk.RateLimitError) throw new AiDraftError(429, "The AI service is busy — please try again in a minute.");
    if (AnthropicSdk && err instanceof AnthropicSdk.APIError) throw new AiDraftError(502, "The AI service couldn't draft questions right now. Please try again.");
    if (err && /credentials|api key|apiKey/i.test(err.message || "")) throw new AiDraftError(503, "AI drafting isn't set up on this server yet (no Anthropic API key).");
    throw err;
  }

  if (response.stop_reason === "refusal") throw new AiDraftError(422, "The AI declined to draft questions for this content.");
  const textBlock = [...response.content].reverse().find((b) => b.type === "text");
  let parsed;
  try { parsed = JSON.parse(textBlock?.text || ""); } catch (e) { throw new AiDraftError(502, "The AI returned an unreadable answer. Please try again."); }

  const seen = new Set(existing.map((q) => normalize(q.question)));
  const drafts = (parsed.questions || [])
    .filter((q) => q && q.question && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 8
      && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < q.options.length
      && q.options.every((o) => String(o).trim()))
    .filter((q) => { const k = normalize(q.question); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, n)
    .map((q) => ({
      moduleId: new mongoose.Types.ObjectId(String(moduleId)),
      question: String(q.question).trim().slice(0, 2000),
      options: q.options.map((o) => String(o).trim().slice(0, 500)),
      correctIndex: q.correctIndex,
      explanation: String(q.explanation || "").trim().slice(0, 2000),
      difficulty: ["easy", "medium", "hard"].includes(q.difficulty) ? q.difficulty : "medium",
      status: "draft",
      source: "ai",
      createdBy: userId || null,
    }));

  const created = drafts.length ? await BankQuestion.insertMany(drafts) : [];
  return { created: created.length, model: response.model };
}

module.exports = { draftQuestions, moduleMaterial, AiDraftError, htmlToText, SCHEMA };
