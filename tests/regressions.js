"use strict";

// Run with: node tests/regressions.js
// Exercise the real browser controllers with intercepted Windows voice-typing requests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const storage = new Map();
const timeouts = new Map();
let timerId = 0;
let countdowns = 0;
let winHCalls = 0;
let ensureCalls = 0;
let pausedMic = false;
let micActivations = 0;

const context = {
  window: {},
  document: { hasFocus: () => true },
  localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
  setTimeout: (fn, delay) => { const id = ++timerId; timeouts.set(id, { fn, delay }); return id; },
  clearTimeout: (id) => timeouts.delete(id),
  clearInterval: () => {},
  requestAnimationFrame: (fn) => fn(),
  Event: class { constructor(type) { this.type = type; } },
  console,
};
vm.createContext(context);
const appSource = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
vm.runInContext(appSource.slice(0, appSource.indexOf("async function boot")) + "\nthis.Repeat = Repeat; this.Email = Email;", context);
vm.runInContext(fs.readFileSync(path.join(root, "static/sections.js"), "utf8") + "\nthis.FullMock = FullMock; this.Blanks = Blanks; this.MockHistory = MockHistory;", context);
const api = context.window.VT;
const mock = context.FullMock;
api.countdown = (seconds, onTick) => { countdowns++; onTick(seconds * 1000, seconds * 1000); return () => {}; };
api.pressWinH = async () => { winHCalls++; return { ok: true }; };
api.ensureVoiceTyping = async (open) => {
  if (!context.document.hasFocus()) return { ok: false, reason: "not_foreground" };
  ensureCalls++;
  if (!open) winHCalls++;
  if (pausedMic) { micActivations++; pausedMic = false; }
  return { ok: true, panelOpen: true, state: "listening" };
};
const data = {};
for (const name of ["sentences", "emails", "passages", "stories", "responses", "situations", "listen", "reading", "dictation", "blanks", "jumbled", "readaloud"]) {
  data[name] = JSON.parse(fs.readFileSync(path.join(root, "data", name + ".json"), "utf8"));
}
api.state.data = data;

function element() {
  return { value: "", textContent: "", style: {}, classList: { add() {}, remove() {}, toggle() {} },
    focus() { context.document.activeElement = this; }, setSelectionRange() {}, dispatchEvent() {}, insertAdjacentHTML() {}, scrollIntoView() {},
    querySelector() { return { addEventListener() {} }; } };
}

function setupMock(box = element()) {
  mock.el = Object.fromEntries(["home", "run", "summary", "progress", "timer", "bar", "status", "stage", "voice", "done", "start"].map((key) => [key, element()]));
  mock.el.stage.querySelector = () => box;
  return box;
}

async function main() {
  for (const [band, lo, hi] of [["warmup", 6, 8], ["level2", 9, 12], ["level3", 13, 16]]) {
    assert.ok(data.sentences[band].length >= 100);
    assert.equal(new Set(data.sentences[band].map(api.skeleton)).size, data.sentences[band].length);
    for (const sentence of data.sentences[band]) assert.ok(api.countWords(sentence) >= lo && api.countWords(sentence) <= hi, sentence);
  }
  for (const [name, items] of Object.entries(data)) {
    if (!Array.isArray(items)) continue;
    assert.equal(new Set(items.map(api.skeleton)).size, items.length, name + " has duplicate question families");
    if (name !== "reading") assert.ok(items.length >= 100, name);
  }
  for (const email of data.emails) {
    assert.equal(email.points.length, 3);
    assert.ok(api.countWords(email.model) >= 100, email.title);
    assert.equal(api.emailChecks(email.model, email, true).filter((c) => c.status === "bad").length, 0, email.title);
  }
  for (const story of [...data.stories, ...data.passages]) {
    for (const fact of story.facts) assert.ok(api.matchesKeys(story.text, fact.keys), story.title + ": " + fact.label);
  }
  for (const response of data.responses) {
    assert.equal(response.options.length, 3);
    assert.ok(Number.isInteger(response.answer) && response.answer >= 0 && response.answer < 3);
    assert.ok(!/item\s+\d+/i.test(response.prompt));
  }
  for (const item of data.reading.flatMap((x) => x.questions)) {
    assert.ok(item.answer >= 0 && item.answer < item.options.length);
    assert.equal(new Set(item.options).size, item.options.length);
  }
  for (const item of data.jumbled) assert.equal(api.scoreRepeat(item.sentence, item.parts.join(" ")).accuracy, 100);
  for (const item of data.blanks) {
    assert.equal(typeof item.answer, "string");
    assert.ok(!("options" in item), "completion task must not contain answer choices");
    assert.ok(api.matchesBlank("  " + item.answer.toUpperCase() + "  ", item));
    assert.ok(!api.matchesBlank("", item));
  }
  const completion = context.Blanks;
  completion.el = Object.fromEntries(["progress", "timer", "bar", "status", "sentence", "answer", "start", "submit", "summary"].map((key) => [key, element()]));
  completion.queue = data.blanks.slice(0, 2);
  completion.index = 0;
  completion.results = [];
  completion.item();
  assert.match(completion.el.status.textContent, /Type the missing/);
  completion.el.answer.value = data.blanks[0].answer.toUpperCase();
  completion.finish();
  assert.equal(completion.results[0].score, 100);
  completion.el.answer.value = "incorrect";
  completion.finish();
  assert.equal(completion.results[1].score, 0);
  assert.equal(completion.el.submit.disabled, true);
  const html = fs.readFileSync(path.join(root, "static/index.html"), "utf8");
  assert.ok(!html.includes('id="bl-options"'));
  assert.ok(html.includes('id="bl-submit"'));
  for (const [item, typed, expected] of [[data.blanks[0], data.blanks[0].answer, 100], [data.blanks[22], "would", 100], [data.blanks[0], "wrong", 0]]) {
    const box = setupMock();
    mock.steps = [{ type: "blank", item }];
    mock.index = 0;
    mock.results = [];
    mock.begin();
    assert.ok(!mock.el.stage.innerHTML.includes('class="options"'));
    box.value = typed;
    await mock.finish();
    assert.equal(mock.results[0].score, expected);
  }
  console.log("Banks: word bands, unique families, answer indexes, and model answers pass.");

  storage.clear();
  const emailKeys = [];
  // The email-only mock and full mock consume the same history.
  while (emailKeys.length < data.emails.length) {
    const count = Math.min(emailKeys.length % 3 === 0 ? 2 : 1, data.emails.length - emailKeys.length);
    emailKeys.push(...api.takeQuestions(data.emails, "emails", count).picked.map(api.skeleton));
  }
  assert.equal(emailKeys.length, data.emails.length);
  assert.equal(new Set(emailKeys).size, data.emails.length, "no email should repeat before all are used");
  assert.notEqual(api.skeleton(api.takeQuestions(data.emails, "emails", 1).picked[0]), emailKeys.at(-1), "avoid the last email at cycle rollover");

  storage.clear();
  const clones = ["Please send the report to Sana on Monday.", "Please send the report to Aman on Friday.", "The scanner is broken today."];
  assert.equal(api.takeQuestions(clones, "clone-test", 3).picked.length, 2);
  assert.equal(api.chooseDiverse([data.jumbled[0], data.jumbled[1]], 2).length, 2, "jumbled text must contribute to its key");
  storage.set("versant.mock.used.legacy-test", JSON.stringify([clones[0]]));
  assert.equal(api.takeQuestions(clones, "legacy-test", 1).picked[0], clones[2], "history must cover renamed clones");

  storage.clear();
  setupMock();
  const realBegin = mock.begin;
  mock.begin = () => {};
  const repeated = [];
  for (let i = 0; i < 20; i++) {
    await mock.start();
    assert.equal(mock.steps.length, 25);
    assert.equal(new Set(mock.steps.map((step) => api.skeleton(step.item))).size, 25, "mock contains repeated scenario");
    repeated.push(...mock.steps.filter((step) => step.type === "repeat").map((step) => api.skeleton(step.item)));
  }
  assert.equal(new Set(repeated).size, repeated.length, "repeat sentences reused too soon across mocks");
  mock.begin = realBegin;
  console.log("Pickers: shared email history, legacy clones, 20 full mocks, and cycle rollover pass.");

  storage.clear();
  let audioDone;
  context.speak = (_, done) => { audioDone = done; };
  const beforeWinH = winHCalls;
  const beforeClock = countdowns;
  for (let question = 1; question <= 6; question++) {
    const box = setupMock();
    mock.steps = [{ type: "repeat", item: { text: "Please close the door." }, label: "Repeat" }];
    mock.index = 0;
    mock.begin();
    assert.equal(mock.phase, "listen");
    assert.equal(winHCalls, beforeWinH + (question === 1 ? 0 : 1), "no toggle during playback");
    if (question === 4) pausedMic = true;
    audioDone();
    await mock.voicePending;
    await Promise.resolve();
    assert.equal(winHCalls, beforeWinH + 1, "later repeat answers must only refocus, including question four");
    assert.equal(context.document.activeElement, box);
    assert.equal(box.readOnly, false);
    assert.equal(countdowns, beforeClock + question, "timer starts after voice typing is armed");
    assert.equal(mock.voiceOpen, true);
  }
  assert.equal(ensureCalls, 6, "every answer checks Windows listening state");
  assert.equal(micActivations, 1, "question four resumes a paused microphone");
  const storyBox = setupMock();
  mock.beginStory({ text: "A short story." });
  audioDone();
  await mock.voicePending;
  assert.equal(context.document.activeElement, storyBox);
  assert.equal(winHCalls, beforeWinH + 1, "story must reuse the open panel");
  const situationBox = setupMock();
  mock.phase = "answer";
  await Promise.all([mock.armVoice(situationBox), mock.armVoice(situationBox)]);
  assert.equal(context.document.activeElement, situationBox);
  assert.equal(winHCalls, beforeWinH + 1, "concurrent requests must not toggle the panel");
  await mock.closeVoice();
  await mock.closeVoice();
  assert.equal(winHCalls, beforeWinH + 2, "close exactly once");
  assert.equal(mock.voiceOpen, false);
  context.document.hasFocus = () => false;
  assert.equal((await mock.armVoice(situationBox)).reason, "not_foreground");
  assert.equal(winHCalls, beforeWinH + 2, "background window must not receive a shortcut");
  assert.equal(mock.voiceOpen, false);
  context.document.hasFocus = () => true;
  await mock.armVoice(situationBox);
  assert.equal(winHCalls, beforeWinH + 3, "retry must open after focus is restored");
  await context.window.VersantSections.leaveMock();
  assert.equal(mock.voiceOpen, false);
  assert.equal(winHCalls, beforeWinH + 4);
  const practiceBox = element();
  const practiceStarts = winHCalls;
  const practiceChecks = ensureCalls;
  await context.dictate(practiceBox);
  await context.dictate(practiceBox);
  assert.equal(ensureCalls, practiceChecks + 2, "standalone spoken answers must check listening each time");
  assert.equal(winHCalls, practiceStarts + 1, "standalone voice typing opens once and stays open");
  assert.equal(context.document.activeElement, practiceBox);
  await context.window.VersantSections.leavePracticeVoice();
  assert.equal(winHCalls, practiceStarts + 2, "leaving standalone practice closes voice typing");
  assert.ok(!/SpeechRecognition|webkitSpeechRecognition/.test(fs.readFileSync(path.join(root, "static/sections.js"), "utf8")));
  console.log("Win+H: playback boundary, six listening checks, paused microphone resume, story focus, closing, and foreground checks pass.");

  storage.clear();
  const history = context.MockHistory;
  const exampleRows = [{ section: "Email writing", question: "Send an update <script>", yours: "My answer\n<script>alert(1)</script>",
    correct: "Expected sample", expectedLabel: "Expected answer (sample email)", score: 80 }];
  assert.equal(history.save("Email writing mock", exampleRows, "saved-1"), true);
  exampleRows[0].yours = "changed after saving";
  assert.equal(history.read()[0].rows[0].yours, "My answer\n<script>alert(1)</script>", "history must store a snapshot");
  history.save("Email writing mock", exampleRows, "saved-1");
  assert.equal(history.read().length, 1, "the same report must not be stored twice");
  const reportHtml = history.questionHtml(history.read()[0].rows);
  assert.ok(reportHtml.includes("&lt;script&gt;"));
  assert.ok(!reportHtml.includes("<script>"), "saved answers must be escaped");
  assert.ok(reportHtml.includes("My answer"));
  assert.ok(reportHtml.includes("Expected answer (sample email)"));
  const oldSave = api.saveStore;
  api.saveStore = () => { throw new Error("quota exceeded"); };
  assert.equal(history.save("Full mock", exampleRows, "failed"), false, "storage failures must not interrupt reports");
  api.saveStore = oldSave;
  assert.equal(history.read().length, 1);

  const cases = [
    ["blank", data.blanks[0], api.blankAnswer(data.blanks[0])],
    ["reading", data.reading[0], ""], ["passage", data.passages[0], data.passages[0].text],
    ["email", data.emails[0], data.emails[0].model], ["dictation", data.dictation[0], data.dictation[0].text],
    ["response", data.responses[0], ""], ["listen", data.listen[0], ""],
    ["repeat", { text: data.sentences.level2[0] }, data.sentences.level2[0]],
    ["situation", data.situations[0], data.situations[0].model], ["story", data.stories[0], data.stories[0].text],
  ];
  const originalReport = mock.report;
  mock.report = () => {};
  mock.results = [];
  for (const [type, item, answer] of cases) {
    const box = setupMock();
    box.value = answer;
    mock.steps = [{ type, item }]; mock.index = 0; mock.phase = "answer";
    if (type === "reading") { mock.readingQuestions = item.questions.slice(0, 2); mock.picks = mock.readingQuestions.map((q) => q.answer); }
    if (type === "response") mock.choice = item.answer;
    if (type === "listen") {
      mock.listenQ = item.questions.length - 1;
      mock.listenAnswers = item.questions.slice(0, -1).map((q) => q.answer || q.keys[0].split("|")[0]);
      box.value = item.questions.at(-1).answer || item.questions.at(-1).keys[0].split("|")[0];
    }
    await mock.finish();
    await Promise.resolve();
  }
  mock.report = originalReport;
  assert.equal(mock.results.length, 13, "reading/listening subquestions must each have their own result");
  for (const row of mock.results) {
    assert.equal(typeof row.question, "string"); assert.ok(row.question.length);
    assert.equal(typeof row.correct, "string"); assert.equal(typeof row.yours, "string");
  }
  assert.equal(mock.results.find((r) => r.section === "Sentence completion").question, data.blanks[0].text);
  assert.equal(mock.results.find((r) => r.section === "Reading comprehension").context, data.reading[0].text);
  assert.ok(mock.results.find((r) => r.section === "Email writing").question.includes(data.emails[0].situation));
  history.save("Full mock", mock.results, "full-1");
  assert.equal(history.read()[0].rows.length, 13);
  const repeat = context.Repeat;
  repeat.level = "mock"; repeat.phase = "report";
  repeat.session = [{ sentence: data.sentences.level2[0], spoken: data.sentences.level2[0], accuracy: 100 }];
  repeat.el = { summary: element() };
  repeat.renderSummary(); repeat.renderSummary();
  assert.equal(history.read().filter((r) => r.kind === "Repeat sentences mock").length, 1);
  const passage = api.Passage;
  passage.el = Object.fromEntries(["phase", "progress", "hint", "result", "start", "spell", "next", "summary"].map((key) => [key, element()]));
  passage.session = [{ passage: data.passages[0], text: data.passages[0].text, ...passage.scoreAttempt(data.passages[0], data.passages[0].text) }];
  passage.showReport(); passage.showReport();
  assert.equal(history.read().filter((r) => r.kind === "Passage reconstruction mock").length, 1);
  assert.equal(history.read()[0].rows[0].yours, data.passages[0].text);
  console.log("History: immutable saved answers, duplicate-save prevention, storage failure, escaped HTML, and all mock question types pass.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
