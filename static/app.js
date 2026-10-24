"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = { data: {}, helper: false };

/* ---------- shared helpers ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function countWords(text) {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function fmtTime(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function countdown(seconds, onTick, onDone) {
  const total = seconds * 1000;
  const end = performance.now() + total;
  onTick(total, total);
  const id = setInterval(() => {
    const left = Math.max(0, end - performance.now());
    onTick(left, total);
    if (left <= 0) {
      clearInterval(id);
      onDone();
    }
  }, 200);
  return () => clearInterval(id);
}

function loadStore(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function saveStore(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function saveCompletedMock(controller, kind, rows) {
  if (controller.savedMockSession === controller.session) return true;
  const saved = window.VersantSections?.saveMock(kind, rows);
  if (saved !== false) controller.savedMockSession = controller.session;
  return saved;
}

// "a|b|c" matches if any alternative starts a word in the text. Alternatives of
// three characters or fewer must match a whole word ("ad" should not match "added").
function hasAlternative(text, alternatives) {
  return alternatives.split("|").some((raw) => {
    const alt = raw.trim().toLowerCase();
    if (!alt) return false;
    const tail = alt.length <= 3 ? "(?![a-z0-9])" : "";
    return new RegExp(`(^|[^a-z0-9])${escapeRe(alt)}${tail}`).test(text);
  });
}

function matchesKeys(text, keys) {
  const t = text.toLowerCase().replace(/[\u2018\u2019`]/g, "'");
  return keys.every((k) => hasAlternative(t, k));
}

async function pressWinH(delayMs = 200) {
  if (!state.helper) return { ok: false, reason: "offline" };
  try {
    const res = await fetch("/api/winh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delayMs }),
    });
    return await res.json();
  } catch {
    return { ok: false, reason: "offline" };
  }
}

async function ensureVoiceTyping(panelOpen = false) {
  if (!state.helper) return { ok: false, reason: "offline" };
  try {
    const res = await fetch("/api/voice/ensure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ panelOpen }),
    });
    return await res.json();
  } catch {
    return { ok: false, reason: "offline" };
  }
}

function winHFailureMessage(reason) {
  switch (reason) {
    case "voice_state_unknown":
      return "Windows listening could not be confirmed. Click the microphone in the voice-typing panel if it is paused, then speak into this answer box.";
    case "not_foreground":
      return "Win+H was not pressed because this window was not in front. Click the answer box and press Win+H yourself.";
    case "not_windows":
      return "Win+H voice typing only works on Windows. Type your answer instead.";
    case "sendinput_failed":
      return "Windows blocked the Win+H keypress. Press Win+H yourself.";
    default:
      return "The Win+H helper is not running. Start it with: python server.py, or press Win+H yourself.";
  }
}

async function checkHelper() {
  const pill = $("#helper-status");
  try {
    const res = await fetch("/api/health");
    const info = await res.json();
    state.helper = Boolean(info.ok && info.winh);
  } catch {
    state.helper = false;
  }
  pill.className = `pill ${state.helper ? "pill-ok" : "pill-bad"}`;
  pill.textContent = state.helper ? "Win+H helper ready" : "Win+H helper offline";
}

function initTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const changed = !tab.classList.contains("active");
      $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab.dataset.tab}`));
      if (changed) window.VersantSections?.leavePracticeVoice();
      if (tab.dataset.tab !== "repeat") {
        Repeat.stopAudio();
        Repeat.closeDictation(true);
      }
      if (tab.dataset.tab !== "full") window.VersantSections?.leaveMock();
    });
  });
}

/* ---------- repeat sentences ---------- */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function numberToWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000 && n % 100 === 0) return `${ONES[n / 100]} hundred`;
  return null;
}

// Voice typing writes "8 o'clock", "20 copies", "e-mail" or "follow-up" in
// different ways, so both sides are reduced to plain lowercase words first.
function normalizeWords(text) {
  let t = text.toLowerCase()
    .replace(/[\u2018\u2019`]/g, "'")
    .replace(/e-mail/g, "email")
    .replace(/(\d+):00/g, "$1 o'clock")
    .replace(/%/g, " percent")
    .replace(/&/g, " and ")
    .replace(/'/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ");
  const words = [];
  for (const w of t.split(/\s+/).filter(Boolean)) {
    if (/^\d+$/.test(w)) {
      const spelled = numberToWords(Number(w));
      if (spelled) {
        words.push(...spelled.split(" "));
        continue;
      }
    }
    words.push(w === "ok" ? "okay" : w);
  }
  return words;
}

function alignWords(expected, spoken) {
  const n = expected.length;
  const m = spoken.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = expected[i] === spoken[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (expected[i] === spoken[j]) {
      ops.push({ type: "ok", word: expected[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "miss", word: expected[i++] });
    } else {
      ops.push({ type: "extra", word: spoken[j++] });
    }
  }
  while (i < n) ops.push({ type: "miss", word: expected[i++] });
  while (j < m) ops.push({ type: "extra", word: spoken[j++] });
  return ops;
}

const SMALL_WORDS = new Set(["a", "an", "the", "to", "of", "in", "on", "at", "for", "and", "is", "are", "was", "be", "by", "it", "this", "that", "from", "with", "so"]);

function scoreRepeat(sentence, answer) {
  const expected = normalizeWords(sentence);
  const spoken = normalizeWords(answer);
  const ops = alignWords(expected, spoken);
  const correct = ops.filter((o) => o.type === "ok").length;
  const missed = ops.filter((o) => o.type === "miss").map((o) => o.word);
  const extra = ops.filter((o) => o.type === "extra").map((o) => o.word);
  return {
    ops,
    correct,
    total: expected.length,
    missed,
    extra,
    accuracy: expected.length ? Math.round((correct / expected.length) * 100) : 0,
    onlySmallMissed: missed.length > 0 && missed.every((w) => SMALL_WORDS.has(w)),
  };
}

const LEVEL_NAMES = { warmup: "Warm-up", level2: "Level 2", level3: "Level 3", level23: "Level 2 and 3", mock: "Mock test" };

const SKEL_NAMES = new Set("asha sana pooja meera farah isha kavya ravi karan anil varun rohan rahul dev harsh aditya imran arjun arun aman anita neha leela tara maya diya nandini sneha priya nikhil vikram kabir ananya menon sharma kapoor thomas iyer mehta shah verma nair singh".split(" "));
const SKEL_PLACES = new Set("mysore delhi pune chennai kochi surat indore lucknow jaipur nagpur mumbai bangalore bengaluru hyderabad kolkata ahmedabad".split(" "));
const SKEL_DAYS = new Set("sunday monday tuesday wednesday thursday friday saturday".split(" "));
const SKEL_NUMBERS = new Set("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred".split(" "));

function questionText(item) {
  if (typeof item === "string") return item;
  return item.prompt || item.situation || item.text || item.sentence || item.parts?.join(" ") || item.title || "";
}

function blankAnswer(item) {
  return typeof item.answer === "string" ? item.answer : item.options[item.answer];
}

function matchesBlank(text, item) {
  const clean = (value) => String(value).trim().toLowerCase().replace(/\s+/g, " ");
  return [blankAnswer(item), ...(item.acceptedAnswers || [])].some((answer) => clean(answer) === clean(text));
}

function skeleton(item) {
  // The same authored scenario can teach several skills. Pick it only once
  // in a mock, even when the email and listening versions use different text.
  if (typeof item === "object" && item.family) return "family:" + item.family;
  if (typeof item === "object" && item.source) return skeleton(item.source);
  const text = questionText(item);
  const words = text.toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\b([a-z]+)'s\b/g, "$1")
    .replace(/\b(?:new york|new delhi|los angeles)\b/g, "city")
    .replace(/today,\s*item\s*\d+/g, " ")
    .replace(/\bitem\s*\d+\b/g, " ")
    .replace(/[^a-z0-9']+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => (word === "city" || SKEL_NAMES.has(word) || SKEL_PLACES.has(word) || SKEL_DAYS.has(word) || SKEL_NUMBERS.has(word) || /^\d+$/.test(word) ? "#" : word));
  return words.join(" ").replace(/#(?: #)+/g, "#");
}

function chooseDiverse(shuffled, count, seen) {
  if (count <= 0) return [];
  const own = seen || new Set();
  const picked = [];
  for (const item of shuffled) {
    const key = skeleton(item);
    if (own.has(key)) continue;
    own.add(key);
    picked.push(item);
    if (picked.length >= count) return picked;
  }
  return picked;
}

function takeQuestions(pool, key, count, seen = new Set()) {
  const storeKey = "versant.questions.v2." + key;
  const saved = loadStore(storeKey, null);
  const identity = (item) => typeof item === "string" ? item : item.id || item.title || questionText(item);
  // Migrate previous history, including all variants of an already seen clone.
  const legacy = saved ? [] : ["versant.practice.used.", "versant.mock.used."]
    .flatMap((prefix) => loadStore(prefix + key, []));
  let used = new Set(saved?.used || pool.filter((item) => legacy.includes(identity(item))).map(skeleton));
  const recent = new Set(saved?.recent || []);
  const unique = chooseDiverse(pool, pool.length);
  const available = unique.filter((item) => !seen.has(skeleton(item)));
  const target = Math.min(count, available.length);
  const picked = chooseDiverse(shuffle(available.filter((item) => !used.has(skeleton(item)))), target, seen);
  let restarted = false;
  if (picked.length < target) {
    restarted = true;
    used = new Set();
    const remaining = available.filter((item) => !seen.has(skeleton(item)));
    const freshFirst = [...shuffle(remaining.filter((item) => !recent.has(skeleton(item)))),
      ...shuffle(remaining.filter((item) => recent.has(skeleton(item))))];
    picked.push(...chooseDiverse(freshFirst, target - picked.length, seen));
  }
  picked.forEach((item) => used.add(skeleton(item)));
  saveStore(storeKey, { used: [...used], recent: picked.map(skeleton) });
  return { picked, restarted };
}

function takeUnseenStrings(pool, key, count, seen) {
  return takeQuestions(pool, key, count, seen);
}

const Repeat = {
  queue: [],
  idx: 0,
  phase: "idle",
  level: "level2",
  dictationOpen: false,
  dictationOpening: false,
  plays: 0,
  utterance: null,
  fallbackTimer: null,
  audioDone: false,
  session: [],
  voices: [],

  init() {
    this.el = {
      level: $("#rs-level"), voice: $("#rs-voice"), rate: $("#rs-rate"),
      autoWinH: $("#rs-auto-winh"), closeWinH: $("#rs-close-winh"), autoNext: $("#rs-auto-next"),
      progress: $("#rs-progress"), length: $("#rs-length"), play: $("#rs-play"), status: $("#rs-status"),
      answer: $("#rs-answer"), voiceTyping: $("#rs-voice-typing"), replay: $("#rs-replay"),
      check: $("#rs-check"), next: $("#rs-next"), result: $("#rs-result"), summary: $("#rs-summary"),
      stats: $("#rs-stats"), reset: $("#rs-reset"),
    };
    const prefs = loadStore("versant.rs.prefs", {});
    if (prefs.level) this.el.level.value = prefs.level;
    if (prefs.rate) this.el.rate.value = prefs.rate;
    for (const k of ["autoWinH", "closeWinH", "autoNext"]) {
      if (typeof prefs[k] === "boolean") this.el[k].checked = prefs[k];
    }

    this.loadVoices();
    if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => this.loadVoices();

    this.el.level.addEventListener("change", () => { this.savePrefs(); this.startLevel(); });
    [this.el.voice, this.el.rate, this.el.autoWinH, this.el.closeWinH, this.el.autoNext]
      .forEach((e) => e.addEventListener("change", () => this.savePrefs()));
    this.el.play.addEventListener("click", () => this.play());
    this.el.replay.addEventListener("click", () => this.replay());
    this.el.voiceTyping.addEventListener("click", () => this.startVoiceTyping());
    this.el.check.addEventListener("click", () => this.check());
    this.el.next.addEventListener("click", () => this.next());
    this.el.reset.addEventListener("click", () => {
      if (confirm("Clear all repeat-sentence history?")) {
        saveStore("versant.rs.history", []);
        this.renderStats();
      }
    });
    this.el.answer.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (this.phase === "answering") this.check();
      else if (this.phase === "checked") this.next();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !$("#tab-repeat").classList.contains("active")) return;
      if (e.target === this.el.answer || e.target.tagName === "BUTTON" || e.target.tagName === "SELECT") return;
      if (this.phase === "checked") this.next();
    });

    this.startLevel();
    this.renderStats();
  },

  savePrefs() {
    saveStore("versant.rs.prefs", {
      level: this.el.level.value, rate: this.el.rate.value, voice: this.el.voice.value,
      autoWinH: this.el.autoWinH.checked, closeWinH: this.el.closeWinH.checked, autoNext: this.el.autoNext.checked,
    });
  },

  loadVoices() {
    if (!("speechSynthesis" in window)) {
      this.el.voice.innerHTML = "<option>Speech not supported in this browser</option>";
      return;
    }
    const all = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
    // Jenny is a clear adult American voice, closest to the Versant speaker.
    // Ana and Maisie sit at the bottom because they sound young.
    const preferred = ["jenny", "guy", "aria", "andrew", "christopher", "eric", "brian", "emma", "michelle", "roger", "neerja", "prabhat", "libby"];
    const score = (v) => {
      const name = v.name.toLowerCase();
      const natural = /natural/i.test(name) ? 0 : 100;
      const lang = /en-us/i.test(v.lang) ? 0 : /en-gb/i.test(v.lang) ? 3 : /en-in/i.test(v.lang) ? 6 : 9;
      const young = /ana|maisie/.test(name) ? 40 : 0;
      const place = preferred.findIndex((n) => name.includes(n));
      return natural + lang + young + (place === -1 ? 30 : place);
    };
    this.voices = all.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
    const saved = loadStore("versant.rs.prefs", {}).voice;
    this.el.voice.innerHTML = this.voices
      .map((v) => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name.replace(/^Microsoft /, ""))} (${escapeHtml(v.lang)})</option>`)
      .join("") || "<option value=''>Default voice</option>";
    if (saved && !/ana|maisie/i.test(saved) && this.voices.some((v) => v.name === saved)) this.el.voice.value = saved;
  },

  buildQueue(level) {
    const bank = state.data.sentences;
    let taken;
    if (level === "level23") {
      const pool = [...bank.level2, ...bank.level3].filter((s) => {
        const n = countWords(s);
        return n >= 9 && n <= 14;
      });
      taken = takeUnseenStrings(pool, "level23", 36);
    } else if (level === "mock") {
      const seen = new Set();
      const warm = takeUnseenStrings(bank.warmup, "warmup", 3, seen);
      const mid = takeUnseenStrings(bank.level2, "level2", 6, seen);
      const hard = takeUnseenStrings(bank.level3, "level3", 7, seen);
      taken = {
        picked: [...warm.picked, ...mid.picked, ...hard.picked].sort((a, b) => countWords(a) - countWords(b)),
        restarted: warm.restarted || mid.restarted || hard.restarted,
      };
    } else {
      taken = takeUnseenStrings(bank[level], level, bank[level].length);
    }
    this.poolRestarted = taken.restarted;
    return taken.picked;
  },

  startLevel() {
    this.stopAudio();
    this.closeDictation(true);
    this.level = this.el.level.value;
    this.queue = this.buildQueue(this.level);
    this.idx = 0;
    this.session = [];
    this.el.summary.classList.add("hidden");
    this.resetItem();
    const again = this.poolRestarted ? " You have seen every item in this set, so it is starting again." : "";
    this.setStatus("Press Play. The sentence is spoken once and the text stays hidden." + again, this.poolRestarted ? "warn" : "");
  },

  get current() {
    return this.queue[this.idx];
  },

  resetItem() {
    this.phase = "idle";
    this.plays = 0;
    this.el.answer.value = "";
    this.el.answer.readOnly = true;
    this.el.result.classList.add("hidden");
    this.el.progress.textContent = `${LEVEL_NAMES[this.level]}: sentence ${this.idx + 1} of ${this.queue.length}`;
    this.el.length.textContent = `${countWords(this.current)} words`;
    this.updateButtons();
  },

  updateButtons() {
    const p = this.phase;
    const report = p === "report";
    this.el.play.disabled = p === "playing" || p === "answering" || p === "checked" || report;
    this.el.replay.disabled = p !== "answering" || this.level === "mock";
    this.el.voiceTyping.disabled = p !== "answering";
    this.el.check.disabled = p !== "answering";
    this.el.next.disabled = p !== "checked" && !report;
    this.el.next.textContent = report ? "Start new set" : "Next (Enter)";
  },

  setStatus(text, cls = "") {
    this.el.status.textContent = text;
    this.el.status.className = `status ${cls}`;
  },

  stopAudio() {
    clearTimeout(this.fallbackTimer);
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (this.phase === "playing") {
      this.phase = "idle";
      this.updateButtons();
    }
  },

  speak(text, onDone) {
    if (!("speechSynthesis" in window)) {
      this.setStatus("This browser cannot play speech. Try Edge, Chrome, or another browser with speech synthesis.", "warn");
      return;
    }
    clearTimeout(this.fallbackTimer);
    this.audioDone = false;
    const finish = () => {
      if (this.audioDone || this.phase !== "playing") return;
      this.audioDone = true;
      clearTimeout(this.fallbackTimer);
      onDone();
    };
    const start = () => {
      if (this.audioDone || this.phase !== "playing") return;
      const u = new SpeechSynthesisUtterance(text);
      const voice = this.voices.find((v) => v.name === this.el.voice.value);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else {
        u.lang = "en-US";
      }
      u.rate = Number(this.el.rate.value) || 0.9;
      // Do not wait for onstart. The first utterance after cancel() is often
      // dropped, and then the answer box never opens.
      const ms = (countWords(text) * 500) / u.rate + 3000;
      this.fallbackTimer = setTimeout(finish, ms);
      u.onend = finish;
      u.onerror = (e) => {
        if (e.error === "interrupted" || e.error === "canceled") return;
        this.setStatus(`Speech error (${e.error}). Try another voice.`, "warn");
        finish();
      };
      this.utterance = u;
      speechSynthesis.resume();
      speechSynthesis.speak(u);
    };
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      setTimeout(start, 120);
    } else {
      start();
    }
  },

  play() {
    if (this.phase !== "idle") return;
    this.el.summary.classList.add("hidden");
    this.plays = 0;
    this.playCurrent();
  },

  playCurrent() {
    this.phase = "playing";
    this.plays++;
    this.el.answer.readOnly = true;
    this.el.answer.value = "";
    this.el.result.classList.add("hidden");
    this.updateButtons();
    this.setStatus((this.poolRestarted && this.idx === 0)
      ? "Listen carefully. You have seen every item in this set, so it is starting again."
      : "Listen carefully...", "live");
    this.speak(this.current, () => this.afterAudio());
  },

  async replay() {
    if (this.phase !== "answering" || this.level === "mock") return;
    await this.closeDictation();
    this.playCurrent();
  },

  async afterAudio() {
    if (this.phase !== "playing") return;
    this.phase = "answering";
    this.el.answer.readOnly = false;
    this.updateButtons();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (this.phase !== "answering") return;
    this.focusAnswer();
    if (!this.el.autoWinH.checked) {
      this.setStatus("Your turn. Repeat the sentence now (press Win+H to use voice typing).", "live");
      return;
    }
    await this.startVoiceTyping();
  },

  focusAnswer() {
    const a = this.el.answer;
    a.focus();
    const end = a.value.length;
    a.setSelectionRange(end, end);
  },

  async startVoiceTyping() {
    if (this.phase !== "answering" || this.dictationOpening) return;
    this.dictationOpening = true;
    try {
    this.focusAnswer();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (this.phase !== "answering") return;
    this.focusAnswer();
    this.setStatus("Checking Windows voice typing...", "live");
    const res = await ensureVoiceTyping(this.dictationOpen);
    if (res.panelOpen) this.dictationOpen = true;
    if (this.phase !== "answering") {
      if (this.dictationOpen) await this.closeDictation(true);
      return;
    }
    this.focusAnswer();
    if (res.ok) {
      this.dictationOpen = true;
      this.setStatus("Speak now. Repeat the whole sentence smoothly, then press Enter to check.", "live");
    } else {
      this.setStatus(winHFailureMessage(res.reason), "warn");
    }
    } finally {
      this.dictationOpening = false;
    }
  },

  async closeDictation(force = false) {
    if (!this.dictationOpen || (!force && !this.el.closeWinH.checked)) return;
    this.dictationOpen = false;
    await pressWinH(0);
  },

  async check() {
    if (this.phase !== "answering") return;
    this.phase = "checked";
    this.updateButtons();
    // Give voice typing a moment to finish writing the last words.
    await new Promise((r) => setTimeout(r, 300));
    await this.closeDictation();
    this.el.answer.readOnly = true;

    const sentence = this.current;
    const r = scoreRepeat(sentence, this.el.answer.value);
    this.session.push({ sentence, spoken: this.el.answer.value, accuracy: r.accuracy, plays: this.plays });
    const history = loadStore("versant.rs.history", []);
    history.push({ level: this.level === "mock" || this.level === "level23" ? this.levelOf(sentence) : this.level, acc: r.accuracy, t: Date.now() });
    saveStore("versant.rs.history", history.slice(-600));
    this.renderResult(sentence, r);
    this.renderStats();

    const last = this.idx === this.queue.length - 1;
    if (last) {
      await this.closeDictation(true);
      this.phase = "report";
      this.updateButtons();
      this.renderSummary();
      this.setStatus(`${LEVEL_NAMES[this.level]} complete. Review each correct sentence and the one you spoke.`);
      this.el.summary.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      this.setStatus("Press Enter or Next for the next sentence.");
      if (this.el.autoNext.checked) setTimeout(() => { if (this.phase === "checked") this.next(); }, 2500);
    }
  },

  levelOf(sentence) {
    for (const k of ["warmup", "level2", "level3"]) if (state.data.sentences[k].includes(sentence)) return k;
    return "level2";
  },

  renderResult(sentence, r) {
    const badgeCls = r.accuracy >= 90 ? "ok" : r.accuracy >= 70 ? "warn" : "bad";
    const label = r.accuracy >= 95 ? "Excellent" : r.accuracy >= 85 ? "Good" : r.accuracy >= 65 ? "Fair" : "Keep practicing";
    const diff = r.ops.map((o) => `<span class="w w-${o.type}">${escapeHtml(o.word)}</span>`).join(" ");
    let note = "";
    if (!this.el.answer.value.trim()) {
      note = "Nothing was captured. Check that voice typing opened in the answer box and that your microphone is on.";
    } else if (r.accuracy === 100) {
      note = "Perfect recall. Now focus on sounding natural and keeping the speaker's rhythm.";
    } else if (r.onlySmallMissed) {
      note = "Only small words were missed. That is fine if you kept speaking smoothly; keep the flow.";
    } else if (r.accuracy < 65) {
      note = "Try chunking: hear the sentence as 3-4 word groups and repeat group by group without stopping.";
    } else {
      note = "Good attempt. Listen for the words shown in red next time.";
    }
    this.el.result.innerHTML = `
      <h3>Result</h3>
      <div class="score-line">
        <span class="badge ${badgeCls}">${r.accuracy}% - ${label}</span>
        <span class="badge">${r.correct}/${r.total} words</span>
        ${r.missed.length ? `<span class="badge bad">${r.missed.length} missed</span>` : ""}
        ${r.extra.length ? `<span class="badge warn">${r.extra.length} extra/changed</span>` : ""}
        ${this.plays > 1 ? `<span class="badge warn">heard ${this.plays} times</span>` : ""}
      </div>
      <div><strong>Sentence:</strong> ${escapeHtml(sentence)}</div>
      <div class="diff">${diff}</div>
      <div class="legend"><span class="w w-ok">correct</span> <span class="w w-miss">missed</span> <span class="w w-extra">extra or changed</span></div>
      <p class="note">${escapeHtml(note)}</p>`;
    this.el.result.classList.remove("hidden");
  },

  renderSummary() {
    const s = this.session;
    if (!s.length) return;
    const avg = Math.round(s.reduce((a, x) => a + x.accuracy, 0) / s.length);
    const perfect = s.filter((x) => x.accuracy === 100).length;
    const saved = this.level === "mock" && this.phase === "report" ? saveCompletedMock(this, "Repeat sentences mock", s.map((x) => ({
      section: "Repeat", question: x.sentence, correct: x.sentence, yours: x.spoken, score: x.accuracy,
    }))) : true;
    const items = s.map((x, i) => {
      const scored = scoreRepeat(x.sentence, x.spoken || "");
      const matched = scored.accuracy === 100 && !scored.extra.length && (x.spoken || "").trim();
      const correctLine = scored.ops
        .filter((o) => o.type !== "extra")
        .map((o) => `<span class="w w-${o.type}">${escapeHtml(o.word)}</span>`)
        .join(" ");
      const yoursLine = (x.spoken || "").trim()
        ? scored.ops.filter((o) => o.type !== "miss").map((o) => `<span class="w w-${o.type}">${escapeHtml(o.word)}</span>`).join(" ")
        : `<span class="muted">(nothing captured)</span>`;
      return `<article class="report-item">
        <div class="score-line">
          <span class="badge">${i + 1}</span>
          <span class="badge ${matched ? "ok" : "bad"}">${matched ? "Correct" : "Incorrect"} · ${scored.accuracy}%</span>
        </div>
        <p><span class="report-label">Correct</span><br>${correctLine}</p>
        <p><span class="report-label">Yours</span><br>${yoursLine}</p>
      </article>`;
    }).join("");
    this.el.summary.innerHTML = `
      <h3>${LEVEL_NAMES[this.level]} report: ${avg}% average</h3>
      <div class="score-line"><span class="badge ok">${perfect} correct</span><span class="badge bad">${s.length - perfect} incorrect</span></div>
      <div class="legend"><span class="w w-ok">matched</span> <span class="w w-miss">missed</span> <span class="w w-extra">extra or changed</span></div>
      ${items}`;
    this.el.summary.classList.remove("hidden");
    if (saved === false) this.el.summary.insertAdjacentHTML("afterbegin", '<p class="status warn">This result could not be saved. Browser storage is unavailable or full.</p>');
  },

  next() {
    if (this.phase === "report") {
      this.queue = this.buildQueue(this.level);
      this.idx = 0;
      this.session = [];
      this.el.summary.classList.add("hidden");
      this.resetItem();
      this.play();
      return;
    }
    if (this.phase !== "checked" || this.idx >= this.queue.length - 1) return;
    this.idx++;
    this.resetItem();
    this.play();
  },

  renderStats() {
    const history = loadStore("versant.rs.history", []);
    const rows = ["warmup", "level2", "level3"].map((lvl) => {
      const items = history.filter((h) => h.level === lvl);
      if (!items.length) return `<tr><td>${LEVEL_NAMES[lvl]}</td><td>0</td><td>-</td><td>-</td></tr>`;
      const recent = items.slice(-20);
      const avg = Math.round(recent.reduce((a, h) => a + h.acc, 0) / recent.length);
      const perfect = items.filter((h) => h.acc === 100).length;
      return `<tr><td>${LEVEL_NAMES[lvl]}</td><td>${items.length}</td><td>${avg}%</td><td>${perfect}</td></tr>`;
    }).join("");
    this.el.stats.innerHTML = `<table><tr><th>Level</th><th>Tries</th><th>Last 20 avg</th><th>Perfect</th></tr>${rows}</table>
      <p class="muted" style="font-size:13px;margin:0 0 8px">Move up a level once your last-20 average stays above 85%.</p>`;
  },
};

/* ---------- passage reconstruction ---------- */

const Passage = {
  idx: 0,
  phase: "idle",
  mode: "practice",
  queue: [],
  step: 0,
  session: [],
  stopTimer: null,

  init() {
    this.el = {
      mode: $("#pr-mode"), picker: $("#pr-picker"), select: $("#pr-select"), random: $("#pr-random"),
      progress: $("#pr-progress"), phase: $("#pr-phase"), timer: $("#pr-timer"), bar: $("#pr-bar"),
      passage: $("#pr-passage"), hint: $("#pr-hint"), answer: $("#pr-answer"), count: $("#pr-count"),
      start: $("#pr-start"), skip: $("#pr-skip"), submit: $("#pr-submit"), next: $("#pr-next"), spell: $("#pr-spell"),
      result: $("#pr-result"), summary: $("#pr-summary"), stats: $("#pr-stats"),
    };
    const list = state.data.passages;
    this.el.select.innerHTML = list.map((p, i) => `<option value="${i}">${i + 1}. ${escapeHtml(p.title)}</option>`).join("");
    this.el.mode.addEventListener("change", () => this.setMode(this.el.mode.value));
    this.el.select.addEventListener("change", () => this.choose(Number(this.el.select.value)));
    this.el.random.addEventListener("click", () => {
      const next = takeQuestions(list, "passages", 1).picked[0];
      this.choose(list.indexOf(next));
    });
    this.el.start.addEventListener("click", () => this.startReading());
    this.el.skip.addEventListener("click", () => this.startWriting());
    this.el.submit.addEventListener("click", () => this.review());
    this.el.next.addEventListener("click", () => this.next());
    this.el.spell.addEventListener("click", () => {
      const a = this.el.answer;
      a.readOnly = false;
      a.spellcheck = true;
      a.focus();
      a.setSelectionRange(0, 0);
      this.el.spell.textContent = "Spelling shown (edits are not rescored)";
      this.el.spell.disabled = true;
    });
    this.el.answer.addEventListener("input", () => {
      this.el.count.textContent = `${countWords(this.el.answer.value)} words`;
    });
    this.choose(0);
    this.renderStats();
  },

  get current() {
    return this.mode === "mock" ? this.queue[this.step] : state.data.passages[this.idx];
  },

  setMode(mode) {
    if (mode === this.mode) return;
    if (this.phase === "read" || this.phase === "write" || this.phase === "between") {
      if (!confirm("Stop the current attempt?")) {
        this.el.mode.value = this.mode;
        return;
      }
    }
    this.mode = mode;
    this.queue = [];
    this.step = 0;
    this.session = [];
    const practice = mode === "practice";
    this.el.select.disabled = !practice;
    this.el.random.classList.toggle("hidden", !practice);
    this.el.picker.classList.toggle("hidden", !practice);
    this.el.summary.classList.add("hidden");
    this.reset();
    if (practice) {
      this.el.hint.textContent = "Press Start. You get 30 seconds to read, then the passage disappears and you have 90 seconds to rewrite it.";
      this.el.progress.textContent = "";
    } else {
      this.el.hint.textContent = "Press Start. Five moderate to hard passages. Each one is 30 seconds to read and 90 seconds to write. The originals appear in the report at the end.";
      this.el.progress.textContent = "Mock test: 5 passages";
      this.el.start.textContent = "Start mock";
    }
  },

  choose(i) {
    if (this.mode === "mock") return;
    if (this.phase === "read" || this.phase === "write") {
      if (!confirm("Stop the current attempt?")) {
        this.el.select.value = String(this.idx);
        return;
      }
    }
    this.idx = i;
    this.el.select.value = String(i);
    this.reset();
  },

  reset() {
    if (this.stopTimer) this.stopTimer();
    this.phase = "idle";
    this.el.phase.textContent = "Ready";
    this.el.phase.className = "phase";
    this.el.timer.textContent = "0:30";
    this.el.timer.classList.remove("low");
    this.el.bar.style.width = "0";
    this.el.passage.classList.add("hidden");
    this.el.hint.classList.remove("hidden");
    this.el.answer.value = "";
    this.el.answer.disabled = true;
    this.el.answer.readOnly = false;
    this.el.answer.spellcheck = false;
    this.el.count.textContent = "0 words";
    this.el.result.classList.add("hidden");
    this.el.start.disabled = false;
    this.el.start.textContent = "Start (30s read)";
    this.el.skip.disabled = true;
    this.el.submit.disabled = true;
    this.el.spell.classList.add("hidden");
    this.el.next.classList.add("hidden");
  },

  tick(left, total) {
    this.el.timer.textContent = fmtTime(left);
    this.el.timer.classList.toggle("low", left <= 10000);
    this.el.bar.style.width = `${((total - left) / total) * 100}%`;
  },

  startReading() {
    if (this.mode === "mock" && this.phase !== "between") {
      const pool = state.data.passages.filter((p) => p.difficulty === "moderate" || p.difficulty === "hard");
      this.queue = takeQuestions(pool, "passages", 5).picked;
      this.step = 0;
      this.session = [];
      this.el.summary.classList.add("hidden");
    }
    if (this.stopTimer) this.stopTimer();
    const p = this.current;
    const mock = this.mode === "mock";
    this.phase = "read";
    this.el.phase.textContent = mock ? `Reading ${this.step + 1} of 5` : "Reading - 30 seconds";
    this.el.phase.className = "phase read";
    this.el.progress.textContent = mock ? `Passage ${this.step + 1} of 5` : "";
    this.el.timer.textContent = "0:30";
    this.el.timer.classList.remove("low");
    this.el.bar.style.width = "0";
    this.el.passage.textContent = p.text;
    this.el.passage.classList.remove("hidden");
    this.el.hint.classList.add("hidden");
    this.el.answer.value = "";
    this.el.answer.disabled = true;
    this.el.answer.readOnly = false;
    this.el.count.textContent = "0 words";
    this.el.result.classList.add("hidden");
    this.el.start.disabled = true;
    this.el.skip.disabled = false;
    this.el.submit.disabled = true;
    this.el.spell.classList.add("hidden");
    this.el.next.classList.add("hidden");
    this.stopTimer = countdown(30, (l, t) => this.tick(l, t), () => this.startWriting());
  },

  startWriting() {
    if (this.phase !== "read") return;
    if (this.stopTimer) this.stopTimer();
    const mock = this.mode === "mock";
    this.phase = "write";
    this.el.phase.textContent = mock ? `Writing ${this.step + 1} of 5` : "Writing - 90 seconds";
    this.el.phase.className = "phase write";
    this.el.passage.classList.add("hidden");
    this.el.skip.disabled = true;
    this.el.submit.disabled = false;
    this.el.answer.disabled = false;
    this.el.answer.focus();
    this.stopTimer = countdown(90, (l, t) => this.tick(l, t), () => this.review());
  },

  scoreAttempt(passage, text) {
    const facts = passage.facts.map((f) => ({ ...f, hit: matchesKeys(text, f.keys) }));
    const hits = facts.filter((f) => f.hit).length;
    const coverage = Math.round((hits / facts.length) * 100);
    const words = countWords(text);
    const originalWords = countWords(passage.text);
    const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const writing = [];
    if (!words) writing.push({ cls: "bad", msg: "Nothing was written." });
    if (words && words < originalWords * 0.7) writing.push({ cls: "warn", msg: `Only ${words} words against ${originalWords} in the passage. A short summary loses marks; include more details.` });
    if (words && words >= originalWords * 0.7) writing.push({ cls: "ok", msg: `${words} words (passage had ${originalWords}). Good length.` });
    const noCap = sentences.filter((s) => /^[a-z]/.test(s)).length;
    if (noCap) writing.push({ cls: "warn", msg: `${noCap} sentence(s) start with a small letter.` });
    if (words && !/[.!?]["')]?\s*$/.test(text.trim())) writing.push({ cls: "warn", msg: "The last sentence has no full stop." });
    if (/(^|\s)i(\s|')/.test(text)) writing.push({ cls: "warn", msg: 'Write "I" as a capital letter.' });
    if (sentences.length === 1 && words > 25) writing.push({ cls: "warn", msg: "Everything is in one long sentence. Split it into shorter sentences." });
    return { facts, hits, coverage, words, writing };
  },

  remember(passage, scored) {
    const history = loadStore("versant.pr.history", []);
    history.push({ title: passage.title, coverage: scored.coverage, words: scored.words, t: Date.now() });
    saveStore("versant.pr.history", history.slice(-200));
    this.renderStats();
  },

  review() {
    if (this.phase !== "write") return;
    if (this.stopTimer) this.stopTimer();
    const p = this.current;
    const text = this.el.answer.value;
    const scored = this.scoreAttempt(p, text);
    this.remember(p, scored);
    this.el.answer.readOnly = true;
    this.el.submit.disabled = true;
    this.el.skip.disabled = true;
    this.el.passage.classList.add("hidden");

    if (this.mode === "mock") {
      this.session.push({ passage: p, text, ...scored });
      if (this.step < this.queue.length - 1) {
        this.phase = "between";
        this.el.phase.textContent = `Saved ${this.step + 1} of 5`;
        this.el.phase.className = "phase";
        this.el.hint.textContent = "Answer saved. The original stays hidden until the report.";
        this.el.hint.classList.remove("hidden");
        this.el.result.classList.add("hidden");
        this.el.start.disabled = true;
        this.el.spell.classList.add("hidden");
        this.el.next.textContent = "Next passage";
        this.el.next.classList.remove("hidden");
        this.el.next.disabled = false;
        return;
      }
      this.showReport();
      return;
    }

    this.phase = "review";
    this.el.phase.textContent = "Time is up - review";
    this.el.phase.className = "phase";
    this.el.start.disabled = false;
    this.el.start.textContent = "Try again";
    this.el.spell.classList.remove("hidden");
    this.el.spell.disabled = false;
    this.el.spell.textContent = "Show spelling mistakes";
    this.el.result.innerHTML = `
      <h3>Details covered: ${scored.hits}/${scored.facts.length} (${scored.coverage}%)</h3>
      <ul class="checklist">${scored.facts.map((f) => `<li class="${f.hit ? "ok" : "bad"}"><span class="mark">${f.hit ? "&#10003;" : "&#10007;"}</span><span>${escapeHtml(f.label)}</span></li>`).join("")}</ul>
      <h3 style="margin-top:14px">Writing checks</h3>
      <ul class="checklist">${scored.writing.map((w) => `<li class="${w.cls}"><span class="mark">${w.cls === "ok" ? "&#10003;" : "!"}</span><span>${escapeHtml(w.msg)}</span></li>`).join("")}</ul>
      <h3 style="margin-top:14px">Original passage</h3>
      <div class="passage">${escapeHtml(p.text)}</div>
      <p class="muted" style="font-size:13px;margin:0">Details are detected by keywords, so compare with the original yourself too.</p>`;
    this.el.result.classList.remove("hidden");
  },

  showReport() {
    this.phase = "report";
    this.el.phase.textContent = "Mock complete";
    this.el.phase.className = "phase";
    this.el.progress.textContent = "Mock test report";
    this.el.hint.classList.add("hidden");
    this.el.result.classList.add("hidden");
    this.el.start.disabled = true;
    this.el.spell.classList.add("hidden");
    this.el.next.textContent = "Start new mock";
    this.el.next.classList.remove("hidden");
    this.el.next.disabled = false;
    const items = this.session;
    const saved = saveCompletedMock(this, "Passage reconstruction mock", items.map((item) => ({
      section: "Passage reconstruction", question: `Reconstruct ${item.passage.title} in your own words, keeping the details.`,
      context: item.passage.text, correct: item.passage.text, expectedLabel: "Expected content (original text)", yours: item.text,
      score: item.coverage, note: item.facts.filter((f) => !f.hit).map((f) => f.label).join("; "),
    })));
    const avg = Math.round(items.reduce((sum, item) => sum + item.coverage, 0) / items.length);
    const blocks = items.map((item, i) => {
      const missed = item.facts.filter((f) => !f.hit);
      const yours = item.text.trim() ? escapeHtml(item.text) : "<span class=\"muted\">(nothing written)</span>";
      const missedList = missed.length
        ? `<ul class="checklist">${missed.map((f) => `<li class="bad"><span class="mark">&#10007;</span><span>${escapeHtml(f.label)}</span></li>`).join("")}</ul>`
        : `<p class="note">All key details were covered.</p>`;
      return `<article class="report-item">
        <div class="score-line"><span class="badge">${i + 1}</span><span class="badge ${item.coverage >= 80 ? "ok" : "bad"}">${escapeHtml(item.passage.title)} · ${item.coverage}%</span><span class="badge">${item.words} words</span></div>
        <p><span class="report-label">Correct</span><br>${escapeHtml(item.passage.text)}</p>
        <p><span class="report-label">Yours</span><br>${yours}</p>
        <p><span class="report-label">Missed</span></p>
        ${missedList}
      </article>`;
    }).join("");
    this.el.summary.innerHTML = `<h3>Passage mock report: ${avg}% average</h3><div class="score-line"><span class="badge">${items.length} passages</span></div>${blocks}`;
    if (saved === false) this.el.summary.insertAdjacentHTML("afterbegin", '<p class="status warn">This result could not be saved. Browser storage is unavailable or full.</p>');
    this.el.summary.classList.remove("hidden");
    this.el.summary.scrollIntoView({ behavior: "smooth", block: "nearest" });
  },

  next() {
    if (this.phase === "report") {
      this.phase = "idle";
      this.startReading();
      return;
    }
    if (this.phase !== "between") return;
    this.step += 1;
    this.startReading();
  },

  renderStats() {
    const history = loadStore("versant.pr.history", []);
    if (!history.length) {
      this.el.stats.innerHTML = `<p class="muted">No attempts yet. Aim to cover at least 80% of the details.</p>`;
      return;
    }
    const recent = history.slice(-10);
    const avg = Math.round(recent.reduce((a, h) => a + h.coverage, 0) / recent.length);
    const rows = history.slice(-5).reverse().map((h) => `<tr><td>${escapeHtml(h.title)}</td><td>${h.coverage}%</td><td>${h.words}</td></tr>`).join("");
    this.el.stats.innerHTML = `<p><strong>${history.length}</strong> attempts. Last 10 average detail coverage: <strong>${avg}%</strong></p>
      <table><tr><th>Passage</th><th>Details</th><th>Words</th></tr>${rows}</table>`;
  },
};

/* ---------- email writing ---------- */

const INFORMAL = ["u", "ur", "r", "pls", "plz", "thx", "thnx", "tnx", "gonna", "wanna", "gotta", "btw", "lol", "omg",
  "hey", "yeah", "yep", "nope", "ok", "cuz", "coz", "bcoz", "bcz", "bro", "dude", "kinda", "sorta", "idk", "imo",
  "msg", "tmrw", "tmr", "bday", "asap", "awesome", "guys", "wassup", "sup"];
const CLOSINGS = /^(best regards|kind regards|warm regards|warmest regards|regards|with regards|thanks and regards|thanks & regards|sincerely|yours sincerely|yours faithfully|yours truly|respectfully|thank you)\b/i;
const PURPOSE = ["i am writing", "i'm writing", "i would like to", "i want to", "regarding", "with reference to", "this is to",
  "to inform you", "to let you know", "i am reaching out", "i am contacting", "i wish to", "i write"];

function emailChecks(text, prompt, final) {
  const lines = text.split("\n").map((l) => l.trim());
  const nonEmpty = lines.map((l, i) => ({ l, i })).filter((x) => x.l);
  const checks = [];
  const add = (status, label, detail = "") => checks.push({ status, label, detail });
  const missing = final ? "bad" : "pending";

  let cursor = 0;
  const hasSubject = nonEmpty.length > 0 && /^subject\s*:/i.test(nonEmpty[0].l);
  if (hasSubject) cursor = 1;
  add(hasSubject ? "ok" : final ? "warn" : "pending", "Subject line", hasSubject ? "" : "Optional, but a clear subject helps the recipient understand the email.");

  const greet = nonEmpty[cursor]?.l || "";
  if (/^(dear|respected)\b/i.test(greet)) add("ok", "Formal greeting", greet);
  else if (/^(hello|good (morning|afternoon|evening))\b/i.test(greet)) add("ok", "Greeting", `${greet} ("Dear ..." is safest)`);
  else if (/^(hi|hey|hii+)\b/i.test(greet)) add("warn", "Greeting is informal", 'Use "Dear Mr./Ms. Name," instead.');
  else add(missing, "Greeting", 'Start with "Dear Mr./Ms. Name,"');

  const nameParts = prompt.to.replace(/^(mr|ms|mrs|dr)\.?\s+/i, "").toLowerCase().split(/\s+/);
  const addressed = nameParts.some((p) => greet.toLowerCase().includes(p));
  add(addressed ? "ok" : missing, `Addressed to ${prompt.to}`, addressed ? "" : "Use the recipient's name from the scenario.");

  const greetIdx = nonEmpty[cursor]?.i ?? -1;
  const body = lines.slice(greetIdx + 1).join("\n");
  const firstWords = body.trim().split(/\s+/).slice(0, 45).join(" ").toLowerCase().replace(/\u2019/g, "'");
  const purposeOk = PURPOSE.some((p) => firstWords.includes(p));
  add(purposeOk ? "ok" : final ? "warn" : "pending", "Purpose stated at the start", purposeOk ? "" : 'Open with "I am writing to ..." or "I am writing regarding ...".');

  prompt.points.forEach((pt, i) => {
    const hit = matchesKeys(body, pt.keys);
    add(hit ? "ok" : missing, `Point ${i + 1}: ${pt.text}`, hit ? "Detected by keywords; make sure it is clear." : "");
  });

  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).length;
  add(paragraphs >= 3 ? "ok" : final ? "warn" : "pending", "Separate paragraphs", `${paragraphs} block(s). Leave a blank line between greeting, body paragraphs and closing.`);

  const closingIdx = nonEmpty.findLastIndex((x, k) => k >= nonEmpty.length - 4 && k > cursor && x.l.length <= 30 && CLOSINGS.test(x.l));
  const informalClose = nonEmpty.slice(-3).some((x) => /^(thanks|cheers|bye|take care)\b/i.test(x.l));
  if (closingIdx >= 0) add("ok", "Professional closing", nonEmpty[closingIdx].l);
  else if (informalClose) add("warn", "Closing is informal", 'Use "Best regards," or "Sincerely,".');
  else add(missing, "Professional closing", 'End with "Best regards," or "Sincerely,".');

  const signed = closingIdx >= 0 && closingIdx < nonEmpty.length - 1;
  add(signed ? "ok" : missing, "Your name after the closing");

  const words = countWords(text);
  add(words >= 100 ? "ok" : words >= 80 ? "warn" : missing, "At least 100 words", `${words} words so far`);

  const tokens = text.toLowerCase().match(/[a-z']+/g) || [];
  const informal = [...new Set(tokens.filter((t) => INFORMAL.includes(t)))];
  const emoji = /\p{Extended_Pictographic}/u.test(text);
  if (informal.length || emoji) {
    add("bad", "Professional tone", `Avoid: ${[...informal, ...(emoji ? ["emoji"] : [])].join(", ")}`);
  } else {
    add(words ? "ok" : "pending", "Professional tone", "No slang, text abbreviations or emoji found");
  }

  const exclaims = (text.match(/!/g) || []).length;
  if (exclaims > 1) add("warn", "Too many exclamation marks", "Keep a calm, formal tone.");
  if (/(^|\s)i(\s|')/.test(text)) add("warn", 'Write "I" as a capital letter');
  return checks;
}

const Email = {
  idx: 0,
  phase: "idle",
  mode: "practice",
  queue: [],
  step: 0,
  session: [],
  stopTimer: null,

  init() {
    this.el = {
      mode: $("#em-mode"), picker: $("#em-picker"), select: $("#em-select"), random: $("#em-random"),
      progress: $("#em-progress"), prompt: $("#em-prompt"), phase: $("#em-phase"),
      timer: $("#em-timer"), bar: $("#em-bar"), answer: $("#em-answer"), count: $("#em-count"),
      start: $("#em-start"), submit: $("#em-submit"), next: $("#em-next"), modelBtn: $("#em-model"), result: $("#em-result"),
      summary: $("#em-summary"), model: $("#em-model-box"), checklist: $("#em-checklist"),
    };
    const list = state.data.emails;
    this.el.select.innerHTML = list.map((e, i) => `<option value="${i}">${i + 1}. ${escapeHtml(e.title)}</option>`).join("");
    this.el.mode.addEventListener("change", () => this.setMode(this.el.mode.value));
    this.el.select.addEventListener("change", () => this.choose(Number(this.el.select.value)));
    this.el.random.addEventListener("click", () => {
      const next = takeQuestions(list, "emails", 1).picked[0];
      this.choose(list.indexOf(next));
    });
    this.el.start.addEventListener("click", () => this.start());
    this.el.submit.addEventListener("click", () => this.finish());
    this.el.next.addEventListener("click", () => this.next());
    this.el.modelBtn.addEventListener("click", () => {
      const hidden = this.el.model.classList.toggle("hidden");
      this.el.modelBtn.textContent = hidden ? "Show model answer" : "Hide model answer";
    });
    this.el.answer.addEventListener("input", () => this.renderLive());
    this.choose(list.indexOf(takeQuestions(list, "emails", 1).picked[0]));
  },

  get prompt() {
    if (this.mode === "mock" && this.queue.length) return this.queue[this.step];
    return state.data.emails[this.idx];
  },

  setMode(mode) {
    if (mode === this.mode) return;
    if (this.phase === "write" || this.phase === "between") {
      if (!confirm("Stop the current attempt?")) {
        this.el.mode.value = this.mode;
        return;
      }
    }
    this.mode = mode;
    this.queue = [];
    this.step = 0;
    this.session = [];
    const practice = mode === "practice";
    this.el.select.disabled = !practice;
    this.el.random.classList.toggle("hidden", !practice);
    this.el.picker.classList.toggle("hidden", !practice);
    this.el.summary.classList.add("hidden");
    if (practice) {
      this.phase = "idle";
      this.choose(this.idx);
      this.el.progress.textContent = "";
      return;
    }
    this.reset();
    this.el.prompt.innerHTML = "<p>Two workplace emails, 9 minutes each. Model answers stay hidden until the report at the end.</p>";
    this.el.progress.textContent = "Mock test: 2 emails";
    this.el.start.textContent = "Start mock";
    this.el.checklist.innerHTML = "";
  },

  choose(i) {
    if (this.mode === "mock") return;
    if (this.phase === "write" && !confirm("Stop the current email?")) {
      this.el.select.value = String(this.idx);
      return;
    }
    this.idx = i;
    this.el.select.value = String(i);
    const p = this.prompt;
    this.el.prompt.innerHTML = `
      <div class="to">To: <strong>${escapeHtml(p.to)}</strong>, ${escapeHtml(p.toRole)}</div>
      <p>${escapeHtml(p.situation)}</p>
      <p><strong>In your email, you must:</strong></p>
      <ol>${p.points.map((pt) => `<li>${escapeHtml(pt.text)}</li>`).join("")}</ol>`;
    this.reset();
  },

  reset() {
    if (this.stopTimer) this.stopTimer();
    this.phase = "idle";
    this.el.phase.textContent = "Ready";
    this.el.phase.className = "phase";
    this.el.timer.textContent = "9:00";
    this.el.timer.classList.remove("low");
    this.el.bar.style.width = "0";
    this.el.answer.value = "";
    this.el.answer.disabled = true;
    this.el.answer.readOnly = false;
    this.el.start.disabled = false;
    this.el.start.textContent = "Start (9 minutes)";
    this.el.submit.disabled = true;
    this.el.modelBtn.classList.add("hidden");
    this.el.modelBtn.textContent = "Show model answer";
    this.el.result.classList.add("hidden");
    this.el.summary.classList.add("hidden");
    this.el.next.classList.add("hidden");
    this.el.model.classList.add("hidden");
    this.el.model.innerHTML = `<h3>Model answer (one good way to write it)</h3>${escapeHtml(this.prompt.model)}`;
    this.renderLive();
  },

  start() {
    if (this.mode === "mock" && this.phase !== "between") {
      this.queue = takeQuestions(state.data.emails, "emails", 2).picked;
      this.step = 0;
      this.session = [];
      this.el.summary.classList.add("hidden");
    }
    if (this.mode !== "mock") this.reset();
    const p = this.prompt;
    this.el.prompt.innerHTML = `
      <div class="to">To: <strong>${escapeHtml(p.to)}</strong>, ${escapeHtml(p.toRole)}</div>
      <p>${escapeHtml(p.situation)}</p>
      <p><strong>In your email, you must:</strong></p>
      <ol>${p.points.map((pt) => `<li>${escapeHtml(pt.text)}</li>`).join("")}</ol>`;
    if (this.stopTimer) this.stopTimer();
    this.phase = "write";
    this.el.phase.textContent = this.mode === "mock" ? `Writing ${this.step + 1} of 2` : "Writing - 9 minutes";
    this.el.phase.className = "phase write";
    if (this.mode === "mock") this.el.progress.textContent = `Email ${this.step + 1} of 2`;
    this.el.timer.textContent = "9:00";
    this.el.timer.classList.remove("low");
    this.el.bar.style.width = "0";
    this.el.answer.value = "";
    this.el.answer.readOnly = false;
    this.el.answer.disabled = false;
    this.el.answer.focus();
    this.el.start.disabled = true;
    this.el.submit.disabled = false;
    this.el.next.classList.add("hidden");
    this.el.model.classList.add("hidden");
    this.el.modelBtn.classList.add("hidden");
    this.el.result.classList.add("hidden");
    this.renderLive();
    this.stopTimer = countdown(540, (left, total) => {
      this.el.timer.textContent = fmtTime(left);
      this.el.timer.classList.toggle("low", left <= 60000);
      this.el.bar.style.width = `${((total - left) / total) * 100}%`;
    }, () => this.finish());
  },

  renderLive() {
    const text = this.el.answer.value;
    const words = countWords(text);
    this.el.count.textContent = `${words} word${words === 1 ? "" : "s"}`;
    this.renderChecklist(emailChecks(text, this.prompt, this.phase === "review"));
  },

  renderChecklist(checks) {
    const marks = { ok: "&#10003;", bad: "&#10007;", warn: "!", pending: "&#8226;" };
    this.el.checklist.innerHTML = checks.map((c) => `
      <li class="${c.status}"><span class="mark">${marks[c.status]}</span>
        <span>${escapeHtml(c.label)}${c.detail ? `<span class="detail">${escapeHtml(c.detail)}</span>` : ""}</span></li>`).join("");
  },

  finish() {
    if (this.phase !== "write") return;
    if (this.stopTimer) this.stopTimer();
    this.el.answer.readOnly = true;
    this.el.submit.disabled = true;
    const checks = emailChecks(this.el.answer.value, this.prompt, true);
    this.renderChecklist(checks);
    if (this.mode === "mock") {
      this.session.push({ prompt: this.prompt, text: this.el.answer.value, checks });
      this.el.model.classList.add("hidden");
      this.el.modelBtn.classList.add("hidden");
      this.el.result.classList.add("hidden");
      if (this.step < this.queue.length - 1) {
        this.phase = "between";
        this.el.phase.textContent = "Email 1 saved";
        this.el.phase.className = "phase";
        this.el.start.disabled = true;
        this.el.next.textContent = "Next email";
        this.el.next.classList.remove("hidden");
        this.el.next.disabled = false;
        return;
      }
      this.showReport();
      return;
    }
    this.phase = "review";
    this.el.phase.textContent = "Finished - review";
    this.el.phase.className = "phase";
    this.el.start.disabled = false;
    this.el.start.textContent = "Try again";
    this.el.modelBtn.classList.remove("hidden");
    const ok = checks.filter((c) => c.status === "ok").length;
    const problems = checks.filter((c) => c.status === "bad");
    const warnings = checks.filter((c) => c.status === "warn");
    const pointsMissing = checks.filter((c) => c.label.startsWith("Point ") && c.status !== "ok");
    const words = countWords(this.el.answer.value);
    this.el.result.innerHTML = `
      <h3>Checklist: ${ok}/${checks.length} passed</h3>
      <div class="score-line">
        <span class="badge ${words >= 100 ? "ok" : "bad"}">${words} words</span>
        <span class="badge ${pointsMissing.length ? "bad" : "ok"}">${3 - pointsMissing.length}/3 required points</span>
        ${problems.length ? `<span class="badge bad">${problems.length} to fix</span>` : ""}
        ${warnings.length ? `<span class="badge warn">${warnings.length} to improve</span>` : ""}
      </div>
      ${pointsMissing.length ? `<p class="note"><strong>Not clearly covered:</strong> ${pointsMissing.map((c) => escapeHtml(c.label.replace(/^Point \d: /, ""))).join("; ")}. Missing a required point costs reading-comprehension marks.</p>` : `<p class="note">All three required points were detected. Read your email once more for spelling and grammar.</p>`}
      ${[...problems, ...warnings].filter((c) => !c.label.startsWith("Point ")).map((c) => `<p class="note">- ${escapeHtml(c.label)}${c.detail ? `: ${escapeHtml(c.detail)}` : ""}</p>`).join("")}`;
    this.el.result.classList.remove("hidden");
  },

  showReport() {
    this.phase = "report";
    this.el.phase.textContent = "Mock complete";
    this.el.phase.className = "phase";
    this.el.progress.textContent = "Mock test report";
    this.el.start.disabled = true;
    this.el.model.classList.add("hidden");
    this.el.modelBtn.classList.add("hidden");
    this.el.result.classList.add("hidden");
    this.el.next.textContent = "Start new mock";
    this.el.next.classList.remove("hidden");
    this.el.next.disabled = false;
    const saved = saveCompletedMock(this, "Email writing mock", this.session.map((item) => {
      const points = item.checks.filter((c) => c.label.startsWith("Point "));
      return { section: "Email writing", question: `To: ${item.prompt.to}, ${item.prompt.toRole}\n${item.prompt.situation}\n${item.prompt.points.map((p, i) => `${i + 1}. ${p.text}`).join("\n")}`,
        correct: item.prompt.model, expectedLabel: "Expected answer (sample email)", yours: item.text,
        score: Math.round((points.filter((p) => p.status === "ok").length / points.length) * 100),
        note: `${countWords(item.text)} words`,
      };
    }));
    const blocks = this.session.map((item, i) => {
      const words = countWords(item.text);
      const points = item.checks.filter((c) => c.label.startsWith("Point "));
      const missed = points.filter((c) => c.status !== "ok");
      const pointList = points.map((c) => `<li class="${c.status === "ok" ? "ok" : "bad"}"><span class="mark">${c.status === "ok" ? "&#10003;" : "&#10007;"}</span><span>${escapeHtml(c.label)}</span></li>`).join("");
      const yours = item.text.trim() ? escapeHtml(item.text) : "<span class=\"muted\">(nothing written)</span>";
      return `<article class="report-item">
        <div class="score-line">
          <span class="badge">${i + 1}</span>
          <span class="badge">${escapeHtml(item.prompt.title)}</span>
          <span class="badge ${words >= 100 ? "ok" : "bad"}">${words} words</span>
          <span class="badge ${missed.length ? "bad" : "ok"}">${points.length - missed.length}/${points.length} points</span>
        </div>
        <p><span class="report-label">Required</span></p>
        <ul class="checklist">${pointList}</ul>
        <p><span class="report-label">Yours</span></p>
        <div class="model">${yours}</div>
        <p><span class="report-label">Model</span></p>
        <div class="model">${escapeHtml(item.prompt.model)}</div>
      </article>`;
    }).join("");
    this.el.summary.innerHTML = `<h3>Email mock report</h3>${blocks}`;
    if (saved === false) this.el.summary.insertAdjacentHTML("afterbegin", '<p class="status warn">This result could not be saved. Browser storage is unavailable or full.</p>');
    this.el.summary.classList.remove("hidden");
    this.el.summary.scrollIntoView({ behavior: "smooth", block: "nearest" });
    this.el.checklist.innerHTML = "<li class=\"ok\"><span class=\"mark\">&#10003;</span><span>Both emails are in the report below.</span></li>";
  },

  next() {
    if (this.phase === "report") {
      this.phase = "idle";
      this.start();
      return;
    }
    if (this.phase !== "between") return;
    this.step += 1;
    this.start();
  },
};

/* ---------- boot ---------- */

window.VT = {
  $, $$, state, escapeHtml, shuffle, countWords, fmtTime, countdown,
  pressWinH, ensureVoiceTyping, winHFailureMessage, scoreRepeat, matchesKeys, emailChecks, Passage, loadStore, saveStore,
  skeleton, chooseDiverse, takeQuestions, blankAnswer, matchesBlank,
};

async function boot() {
  initTabs();
  checkHelper();
  try {
    const names = ["sentences", "passages", "emails", "readaloud", "jumbled", "stories", "blanks", "reading", "dictation", "responses", "listen", "situations"];
    const loaded = await Promise.all(names.map((n) => fetch(`/data/${n}.json`).then((r) => {
      if (!r.ok) throw new Error(n);
      return r.json();
    })));
    names.forEach((n, i) => { state.data[n] = loaded[i]; });
  } catch {
    document.querySelector("main").innerHTML = `<div class="card"><h2>Could not load practice data</h2>
      <p>Start the trainer with <code>python server.py</code> in the project folder and open the address it prints.</p></div>`;
    return;
  }
  Repeat.init();
  Passage.init();
  Email.init();
  if (window.VersantSections) VersantSections.start();
}

boot();
