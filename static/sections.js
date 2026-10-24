"use strict";

const api = () => window.VT;

let clockStop = null;
let speakGen = 0;

function stopClock() {
  if (clockStop) clockStop();
  clockStop = null;
}

function stopAudio() {
  speakGen += 1;
  stopClock();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function clock(seconds, timerEl, barEl, onDone) {
  stopClock();
  const lowAt = seconds <= 30 ? 5000 : 60000;
  clockStop = api().countdown(seconds, (left, total) => {
    timerEl.textContent = api().fmtTime(left);
    timerEl.classList.toggle("low", left <= lowAt);
    if (barEl) barEl.style.width = `${((total - left) / total) * 100}%`;
  }, onDone);
}

function speak(text, onDone, rate = 0.9) {
  const token = ++speakGen;
  if (!("speechSynthesis" in window)) {
    onDone();
    return;
  }
  let finished = false;
  let backup = 0;
  const finish = () => {
    if (finished || token !== speakGen) return;
    finished = true;
    clearTimeout(backup);
    onDone();
  };
  const start = () => {
    if (token !== speakGen) return;
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
    const voice = voices.find((v) => /jenny/i.test(v.name)) || voices[0];
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = "en-US";
    }
    u.rate = rate;
    const wait = (api().countWords(text) * 500) / u.rate + 3000;
    backup = setTimeout(finish, wait);
    u.onend = finish;
    u.onerror = (e) => {
      if (e.error === "interrupted" || e.error === "canceled") return;
      finish();
    };
    speechSynthesis.resume();
    speechSynthesis.speak(u);
  };
  // cancel() in the same turn drops the next utterance, so the first
  // sentence of a section never finishes and Win+H never opens.
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    speechSynthesis.cancel();
    setTimeout(start, 120);
  } else {
    start();
  }
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function focusAnswerBox(input) {
  input.disabled = false;
  input.readOnly = false;
  await nextPaint();
  const place = () => {
    input.focus();
    const end = input.value.length;
    if (input.setSelectionRange) input.setSelectionRange(end, end);
  };
  place();
  if (document.activeElement !== input) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    place();
  }
}

let practiceVoiceOpen = false;
let practiceVoicePending = null;

async function dictate(input) {
  if (practiceVoicePending) await practiceVoicePending;
  await focusAnswerBox(input);
  if (!document.hasFocus()) return { ok: false, reason: "not_foreground" };
  const pending = api().ensureVoiceTyping(practiceVoiceOpen);
  practiceVoicePending = pending;
  const result = await pending.finally(() => { practiceVoicePending = null; });
  if (result.panelOpen || result.ok) practiceVoiceOpen = true;
  if (input.isConnected !== false) await focusAnswerBox(input);
  return result;
}

async function closePracticeVoice() {
  if (practiceVoicePending) await practiceVoicePending;
  if (!practiceVoiceOpen) return;
  practiceVoiceOpen = false;
  await api().pressWinH(0);
}

function dictationNote(res) {
  return res.ok ? "" : api().winHFailureMessage(res.reason);
}

function showReport(el, title, blocks, button, onAgain) {
  el.innerHTML = `<h3>${title}</h3>${blocks}
    <div class="actions"><button type="button" class="btn btn-primary" id="report-again">${button}</button></div>`;
  el.classList.remove("hidden");
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  el.querySelector("#report-again").addEventListener("click", onAgain);
}

function storyScore(story, text) {
  const facts = story.facts.map((f) => ({ ...f, hit: api().matchesKeys(text, f.keys) }));
  const hits = facts.filter((f) => f.hit).length;
  return { facts, hits, coverage: Math.round((hits / facts.length) * 100) };
}

function missedHtml(facts) {
  const missed = facts.filter((f) => !f.hit);
  if (!missed.length) return `<p class="note">All key details were covered.</p>`;
  return `<ul class="checklist">${missed.map((f) => `<li class="bad"><span class="mark">&#10007;</span><span>${api().escapeHtml(f.label)}</span></li>`).join("")}</ul>`;
}

const ReadAloud = {
  queue: [], index: 0, results: [], live: false,
  init() {
    this.el = {
      progress: api().$("#ra-progress"), timer: api().$("#ra-timer"), bar: api().$("#ra-bar"),
      status: api().$("#ra-status"), sentence: api().$("#ra-sentence"), answer: api().$("#ra-answer"),
      start: api().$("#ra-start"), voice: api().$("#ra-voice"), done: api().$("#ra-done"), summary: api().$("#ra-summary"),
    };
    this.el.start.addEventListener("click", () => this.start());
    this.el.done.addEventListener("click", () => this.finish());
    this.el.voice.addEventListener("click", () => this.voice());
  },
  start() {
    stopAudio();
    const taken = practiceQueue(api().state.data.readaloud, "readaloud", 8);
    this.queue = taken.picked;
    this.restarted = taken.restarted;
    this.index = 0;
    this.results = [];
    this.el.summary.classList.add("hidden");
    this.el.start.disabled = true;
    this.item();
  },
  item() {
    const sentence = this.queue[this.index];
    this.live = true;
    this.el.progress.textContent = `Sentence ${this.index + 1} of ${this.queue.length}`;
    this.el.sentence.textContent = sentence;
    this.el.sentence.classList.remove("hidden");
    this.el.answer.value = "";
    this.el.answer.readOnly = false;
    this.el.done.disabled = false;
    this.el.voice.disabled = false;
    this.el.status.textContent = "Read the sentence aloud.";
    noteRestart(this.el.status, this.restarted && this.index === 0);
    this.el.status.className = "status live";
    clock(15, this.el.timer, this.el.bar, () => this.finish());
    dictate(this.el.answer).then((res) => {
      const note = dictationNote(res);
      if (note && this.live) {
        this.el.status.textContent = note;
        this.el.status.className = "status warn";
      }
    });
  },
  voice() { if (this.live) dictate(this.el.answer); },
  finish() {
    if (!this.live) return;
    this.live = false;
    stopClock();
    const sentence = this.queue[this.index];
    const scored = api().scoreRepeat(sentence, this.el.answer.value);
    this.results.push({ correct: sentence, yours: this.el.answer.value, score: scored.accuracy });
    this.index += 1;
    if (this.index < this.queue.length) this.item();
    else this.report();
  },
  report() {
    closePracticeVoice();
    this.el.done.disabled = true;
    this.el.voice.disabled = true;
    this.el.start.disabled = false;
    this.el.start.textContent = "Start new set";
    const avg = Math.round(this.results.reduce((s, r) => s + r.score, 0) / this.results.length);
    const blocks = this.results.map((r, i) => `<article class="report-item">
      <div class="score-line"><span class="badge">${i + 1}</span><span class="badge ${r.score >= 90 ? "ok" : "bad"}">${r.score}%</span></div>
      <p><span class="report-label">Correct</span><br>${api().escapeHtml(r.correct)}</p>
      <p><span class="report-label">Yours</span><br>${r.yours.trim() ? api().escapeHtml(r.yours) : '<span class="muted">(nothing captured)</span>'}</p>
    </article>`).join("");
    this.el.status.textContent = "Set complete.";
    showReport(this.el.summary, `Reading aloud: ${avg}%`, blocks, "Start new set", () => this.start());
  },
};

const Jumble = {
  queue: [], index: 0, results: [], picked: [], live: false,
  init() {
    this.el = {
      progress: api().$("#ju-progress"), timer: api().$("#ju-timer"), bar: api().$("#ju-bar"),
      status: api().$("#ju-status"), bank: api().$("#ju-bank"), built: api().$("#ju-built"),
      start: api().$("#ju-start"), clear: api().$("#ju-clear"), done: api().$("#ju-done"), summary: api().$("#ju-summary"),
    };
    this.el.start.addEventListener("click", () => this.start());
    this.el.done.addEventListener("click", () => this.finish());
    this.el.clear.addEventListener("click", () => { this.picked = []; this.paint(); });
  },
  start() {
    stopAudio();
    const taken = practiceQueue(api().state.data.jumbled, "jumbled", 8);
    this.queue = taken.picked;
    this.restarted = taken.restarted;
    this.index = 0;
    this.results = [];
    this.el.summary.classList.add("hidden");
    this.el.start.disabled = true;
    this.item();
  },
  item() {
    this.live = true;
    this.picked = [];
    this.order = api().shuffle([0, 1, 2]);
    this.el.progress.textContent = `Sentence ${this.index + 1} of ${this.queue.length}`;
    this.el.done.disabled = false;
    this.el.clear.disabled = false;
    this.el.status.textContent = "Tap the phrases in order.";
    noteRestart(this.el.status, this.restarted && this.index === 0);
    this.el.status.className = "status live";
    this.paint();
    clock(15, this.el.timer, this.el.bar, () => this.finish());
  },
  paint() {
    const item = this.queue[this.index];
    const chip = (label, action, index) => `<button type="button" class="chip" data-act="${action}" data-i="${index}">${api().escapeHtml(label)}</button>`;
    this.el.bank.innerHTML = this.order.filter((i) => !this.picked.includes(i)).map((i) => chip(item.parts[i], "add", i)).join("");
    this.el.built.innerHTML = this.picked.map((i) => chip(item.parts[i], "remove", i)).join("") || `<span class="muted">Tap a phrase above.</span>`;
    this.el.bank.querySelectorAll(".chip").forEach((btn) => btn.addEventListener("click", () => {
      if (!this.live) return;
      this.picked.push(Number(btn.dataset.i));
      this.paint();
    }));
    this.el.built.querySelectorAll(".chip").forEach((btn) => btn.addEventListener("click", () => {
      if (!this.live) return;
      this.picked = this.picked.filter((i) => i !== Number(btn.dataset.i));
      this.paint();
    }));
  },
  finish() {
    if (!this.live) return;
    this.live = false;
    stopClock();
    const item = this.queue[this.index];
    const ok = this.picked.length === 3 && this.picked.every((n, i) => n === i);
    const yours = this.picked.map((i) => item.parts[i]).join(" ");
    this.results.push({ correct: item.sentence, yours, score: ok ? 100 : 0 });
    this.index += 1;
    if (this.index < this.queue.length) this.item();
    else this.report();
  },
  report() {
    this.el.done.disabled = true;
    this.el.clear.disabled = true;
    this.el.start.disabled = false;
    this.el.start.textContent = "Start new set";
    this.el.bank.innerHTML = "";
    this.el.built.innerHTML = "";
    const right = this.results.filter((r) => r.score === 100).length;
    const blocks = this.results.map((r, i) => `<article class="report-item">
      <div class="score-line"><span class="badge">${i + 1}</span><span class="badge ${r.score ? "ok" : "bad"}">${r.score ? "Correct" : "Incorrect"}</span></div>
      <p><span class="report-label">Correct</span><br>${api().escapeHtml(r.correct)}</p>
      <p><span class="report-label">Yours</span><br>${r.yours ? api().escapeHtml(r.yours) : '<span class="muted">(nothing selected)</span>'}</p>
    </article>`).join("");
    this.el.status.textContent = "Set complete.";
    showReport(this.el.summary, `Jumbled sentences: ${right}/${this.results.length}`, blocks, "Start new set", () => this.start());
  },
};

const Stories = {
  queue: [], index: 0, results: [], phase: "idle",
  init() {
    this.el = {
      progress: api().$("#st-progress"), timer: api().$("#st-timer"), bar: api().$("#st-bar"),
      status: api().$("#st-status"), answer: api().$("#st-answer"),
      start: api().$("#st-start"), voice: api().$("#st-voice"), done: api().$("#st-done"), summary: api().$("#st-summary"),
    };
    this.el.start.addEventListener("click", () => this.start());
    this.el.done.addEventListener("click", () => this.finish());
    this.el.voice.addEventListener("click", () => { if (this.phase === "tell") dictate(this.el.answer); });
  },
  start() {
    stopAudio();
    const taken = practiceQueue(api().state.data.stories, "stories", 3);
    this.queue = taken.picked;
    this.restarted = taken.restarted;
    this.index = 0;
    this.results = [];
    this.el.summary.classList.add("hidden");
    this.el.start.disabled = true;
    this.play();
  },
  play() {
    this.phase = "listen";
    this.el.progress.textContent = `Story ${this.index + 1} of ${this.queue.length}`;
    this.el.answer.value = "";
    this.el.answer.readOnly = true;
    this.el.done.disabled = true;
    this.el.voice.disabled = true;
    this.el.status.textContent = "Listen. The story is played once.";
    noteRestart(this.el.status, this.restarted && this.index === 0);
    this.el.status.className = "status live";
    this.el.timer.textContent = "";
    speak(this.queue[this.index].text, () => this.tell(), 0.8);
  },
  tell() {
    if (this.phase !== "listen") return;
    this.phase = "tell";
    this.el.answer.readOnly = false;
    this.el.done.disabled = false;
    this.el.voice.disabled = false;
    this.el.status.textContent = "Retell the story in your own words. You have 30 seconds.";
    clock(30, this.el.timer, this.el.bar, () => this.finish());
    dictate(this.el.answer).then((res) => {
      const note = dictationNote(res);
      if (note && this.phase === "tell") {
        this.el.status.textContent = note;
        this.el.status.className = "status warn";
      }
    });
  },
  finish() {
    if (this.phase !== "tell") return;
    this.phase = "idle";
    stopClock();
    const story = this.queue[this.index];
    const scored = storyScore(story, this.el.answer.value);
    this.results.push({ story, yours: this.el.answer.value, ...scored });
    this.index += 1;
    if (this.index < this.queue.length) this.play();
    else this.report();
  },
  report() {
    closePracticeVoice();
    this.el.done.disabled = true;
    this.el.voice.disabled = true;
    this.el.start.disabled = false;
    this.el.start.textContent = "Start new set";
    const avg = Math.round(this.results.reduce((s, r) => s + r.coverage, 0) / this.results.length);
    const blocks = this.results.map((r, i) => `<article class="report-item">
      <div class="score-line"><span class="badge">${i + 1}</span><span class="badge ${r.coverage >= 75 ? "ok" : "bad"}">${api().escapeHtml(r.story.title)} · ${r.coverage}%</span></div>
      <p><span class="report-label">Correct</span><br>${api().escapeHtml(r.story.text)}</p>
      <p><span class="report-label">Yours</span><br>${r.yours.trim() ? api().escapeHtml(r.yours) : '<span class="muted">(nothing captured)</span>'}</p>
      ${missedHtml(r.facts)}
    </article>`).join("");
    this.el.status.textContent = "Set complete.";
    showReport(this.el.summary, `Story retelling: ${avg}%`, blocks, "Start new set", () => this.start());
  },
};

const Blanks = {
  queue: [], index: 0, results: [], live: false,
  init() {
    this.el = {
      progress: api().$("#bl-progress"), timer: api().$("#bl-timer"), bar: api().$("#bl-bar"),
      status: api().$("#bl-status"), sentence: api().$("#bl-sentence"),
      answer: api().$("#bl-answer"),
      start: api().$("#bl-start"), submit: api().$("#bl-submit"), summary: api().$("#bl-summary"),
    };
    this.el.start.addEventListener("click", () => this.start());
    this.el.submit.addEventListener("click", () => this.finish());
    this.el.answer.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.live) { e.preventDefault(); this.finish(); }
    });
  },
  start() {
    stopAudio();
    const taken = practiceQueue(api().state.data.blanks, "blanks", 10);
    this.queue = taken.picked;
    this.restarted = taken.restarted;
    this.index = 0;
    this.results = [];
    this.el.summary.classList.add("hidden");
    this.el.start.disabled = true;
    this.item();
  },
  item() {
    this.live = true;
    const item = this.queue[this.index];
    this.el.progress.textContent = `Question ${this.index + 1} of ${this.queue.length}`;
    this.el.sentence.textContent = item.text;
    this.el.sentence.classList.remove("hidden");
    this.el.answer.disabled = false;
    this.el.submit.disabled = false;
    this.el.answer.value = "";
    this.el.answer.focus();
    this.el.status.textContent = "Type the missing word or phrase, then press Enter or Submit.";
    noteRestart(this.el.status, this.restarted && this.index === 0);
    this.el.status.className = "status live";
    clock(25, this.el.timer, this.el.bar, () => this.finish());
  },
  finish() {
    if (!this.live) return;
    this.live = false;
    stopClock();
    const item = this.queue[this.index];
    const correct = api().blankAnswer(item);
    const yours = this.el.answer.value.trim();
    const ok = api().matchesBlank(yours, item);
    this.results.push({ text: item.text, correct, yours, score: ok ? 100 : 0 });
    this.index += 1;
    if (this.index < this.queue.length) this.item();
    else this.report();
  },
  report() {
    this.el.answer.disabled = true;
    this.el.submit.disabled = true;
    this.el.start.disabled = false;
    this.el.start.textContent = "Start new set";
    const right = this.results.filter((r) => r.score === 100).length;
    const blocks = this.results.map((r, i) => `<article class="report-item">
      <div class="score-line"><span class="badge">${i + 1}</span><span class="badge ${r.score ? "ok" : "bad"}">${r.score ? "Correct" : "Incorrect"}</span></div>
      <p>${api().escapeHtml(r.text)}</p>
      <p><span class="report-label">Correct</span> ${api().escapeHtml(r.correct)}</p>
      <p><span class="report-label">Yours</span> ${r.yours ? api().escapeHtml(r.yours) : '<span class="muted">(no answer)</span>'}</p>
    </article>`).join("");
    this.el.status.textContent = "Set complete.";
    showReport(this.el.summary, `Sentence completion: ${right}/${this.results.length}`, blocks, "Start new set", () => this.start());
  },
};

const Reading = {
  item: null, picks: [], live: false,
  init() {
    this.el = {
      progress: api().$("#rc-progress"), timer: api().$("#rc-timer"), bar: api().$("#rc-bar"),
      status: api().$("#rc-status"), body: api().$("#rc-body"),
      start: api().$("#rc-start"), done: api().$("#rc-done"), summary: api().$("#rc-summary"),
    };
    this.el.start.addEventListener("click", () => this.start());
    this.el.done.addEventListener("click", () => this.finish());
  },
  start() {
    stopAudio();
    const bank = api().state.data.reading;
    const taken = practiceQueue(bank, "reading", 1);
    this.item = taken.picked[0];
    this.restarted = taken.restarted;
    this.picks = this.item.questions.map(() => null);
    this.live = true;
    this.el.summary.classList.add("hidden");
    this.el.start.disabled = true;
    this.el.done.disabled = false;
    this.el.progress.textContent = this.item.title;
    this.el.status.textContent = "Answer all four questions. Two ask what is stated. Two ask what is implied.";
    noteRestart(this.el.status, this.restarted);
    this.el.status.className = "status live";
    this.paint();
    clock(360, this.el.timer, this.el.bar, () => this.finish());
  },
  paint() {
    const q = this.item.questions.map((question, qi) => `
      <div class="q-block">
        <p><strong>${qi + 1}. ${api().escapeHtml(question.q)}</strong> <span class="muted">(${question.kind})</span></p>
        <div class="options">${question.options.map((opt, oi) => `<button type="button" class="btn option ${this.picks[qi] === oi ? "selected" : ""}" data-q="${qi}" data-o="${oi}">${api().escapeHtml(opt)}</button>`).join("")}</div>
      </div>`).join("");
    this.el.body.innerHTML = `<div class="passage">${api().escapeHtml(this.item.text)}</div>${q}`;
    this.el.body.querySelectorAll(".option").forEach((btn) => btn.addEventListener("click", () => {
      if (!this.live) return;
      this.picks[Number(btn.dataset.q)] = Number(btn.dataset.o);
      this.paint();
    }));
  },
  finish() {
    if (!this.live) return;
    this.live = false;
    stopClock();
    this.el.done.disabled = true;
    this.el.start.disabled = false;
    this.el.start.textContent = "New passage";
    const rows = this.item.questions.map((question, i) => {
      const yours = this.picks[i] == null ? "" : question.options[this.picks[i]];
      const ok = this.picks[i] === question.answer;
      return { q: question.q, kind: question.kind, correct: question.options[question.answer], yours, score: ok ? 100 : 0 };
    });
    const right = rows.filter((r) => r.score === 100).length;
    const blocks = rows.map((r, i) => `<article class="report-item">
      <div class="score-line"><span class="badge">${i + 1}</span><span class="badge ${r.score ? "ok" : "bad"}">${r.score ? "Correct" : "Incorrect"}</span><span class="badge">${api().escapeHtml(r.kind)}</span></div>
      <p>${api().escapeHtml(r.q)}</p>
      <p><span class="report-label">Correct</span> ${api().escapeHtml(r.correct)}</p>
      <p><span class="report-label">Yours</span> ${r.yours ? api().escapeHtml(r.yours) : '<span class="muted">(no answer)</span>'}</p>
    </article>`).join("");
    this.el.status.textContent = "Passage complete.";
    showReport(this.el.summary, `${api().escapeHtml(this.item.title)}: ${right}/4`, blocks, "New passage", () => this.start());
  },
};

const Dictation = {
  queue: [], index: 0, results: [], phase: "idle",
  init() {
    this.el = {
      progress: api().$("#dc-progress"), timer: api().$("#dc-timer"), bar: api().$("#dc-bar"),
      status: api().$("#dc-status"), answer: api().$("#dc-answer"),
      start: api().$("#dc-start"), done: api().$("#dc-done"), summary: api().$("#dc-summary"),
    };
    this.el.start.addEventListener("click", () => this.start());
    this.el.done.addEventListener("click", () => this.finish());
  },
  start() {
    stopAudio();
    const taken = practiceQueue(api().state.data.dictation, "dictation", 8);
    this.queue = taken.picked;
    this.restarted = taken.restarted;
    this.index = 0;
    this.results = [];
    this.el.summary.classList.add("hidden");
    this.el.start.disabled = true;
    this.play();
  },
  play() {
    this.phase = "listen";
    const item = this.queue[this.index];
    this.el.progress.textContent = `Sentence ${this.index + 1} of ${this.queue.length}`;
    this.el.answer.value = "";
    this.el.answer.readOnly = true;
    this.el.done.disabled = true;
    this.el.status.textContent = "Listen. The sentence is played once.";
    noteRestart(this.el.status, this.restarted && this.index === 0);
    this.el.status.className = "status live";
    speak(item.text, () => this.type());
  },
  type() {
    if (this.phase !== "listen") return;
    this.phase = "type";
    this.el.answer.readOnly = false;
    this.el.answer.focus();
    this.el.done.disabled = false;
    this.el.status.textContent = "Type the sentence exactly. You have 25 seconds.";
    clock(25, this.el.timer, this.el.bar, () => this.finish());
  },
  finish() {
    if (this.phase !== "type") return;
    this.phase = "idle";
    stopClock();
    const item = this.queue[this.index];
    const yours = this.el.answer.value;
    const scored = api().scoreRepeat(item.text, yours);
    this.results.push({ correct: item.text, yours, score: scored.accuracy, note: punctuationNote(item.text, yours) });
    this.index += 1;
    if (this.index < this.queue.length) this.play();
    else this.report();
  },
  report() {
    this.el.done.disabled = true;
    this.el.start.disabled = false;
    this.el.start.textContent = "Start new set";
    const avg = Math.round(this.results.reduce((s, r) => s + r.score, 0) / this.results.length);
    const blocks = this.results.map((r, i) => `<article class="report-item">
      <div class="score-line"><span class="badge">${i + 1}</span><span class="badge ${r.score >= 90 ? "ok" : "bad"}">${r.score}%</span></div>
      <p><span class="report-label">Correct</span><br>${api().escapeHtml(r.correct)}</p>
      <p><span class="report-label">Yours</span><br>${r.yours.trim() ? api().escapeHtml(r.yours) : '<span class="muted">(nothing typed)</span>'}</p>
      ${r.note ? `<p class="note">${api().escapeHtml(r.note)}</p>` : ""}
    </article>`).join("");
    this.el.status.textContent = "Set complete.";
    showReport(this.el.summary, `Dictation: ${avg}%`, blocks, "Start new set", () => this.start());
  },
};

function punctuationNote(correct, yours) {
  const src = correct.trim();
  const said = yours.trim();
  if (!said) return "";
  const notes = [];
  if (src[0] !== said[0]) notes.push("Check the opening capital letter.");
  if (/[.?!]$/.test(src) && !/[.?!]$/.test(said)) notes.push("Add the final punctuation.");
  return notes.join(" ");
}

const Responses = {
  queue: [], index: 0, results: [], choice: null, phase: "idle",
  init() {
    this.el = {
      progress: api().$("#rsp-progress"), timer: api().$("#rsp-timer"), bar: api().$("#rsp-bar"),
      status: api().$("#rsp-status"), prompt: api().$("#rsp-prompt"), options: api().$("#rsp-options"),
      start: api().$("#rsp-start"), summary: api().$("#rsp-summary"),
    };
    this.el.start.addEventListener("click", () => this.start());
  },
  start() {
    stopAudio();
    const taken = practiceQueue(api().state.data.responses, "responses", 8);
    this.queue = taken.picked;
    this.restarted = taken.restarted;
    this.index = 0;
    this.results = [];
    this.el.summary.classList.add("hidden");
    this.el.start.disabled = true;
    this.play();
  },
  play() {
    this.phase = "listen";
    this.choice = null;
    const item = this.queue[this.index];
    this.el.progress.textContent = `Question ${this.index + 1} of ${this.queue.length}`;
    this.el.prompt.textContent = "";
    this.el.prompt.classList.add("hidden");
    this.el.options.innerHTML = "";
    this.el.status.textContent = "Listen to the sentence.";
    noteRestart(this.el.status, this.restarted && this.index === 0);
    this.el.status.className = "status live";
    speak(item.prompt, () => this.choose());
  },
  choose() {
    if (this.phase !== "listen") return;
    this.phase = "choose";
    const item = this.queue[this.index];
    this.el.prompt.textContent = item.prompt;
    this.el.prompt.classList.remove("hidden");
    this.el.status.textContent = "Choose the best reply. You have 8 seconds.";
    this.el.options.innerHTML = item.options.map((opt, i) => `<button type="button" class="btn option" data-i="${i}">${"ABC"[i]}. ${api().escapeHtml(opt)}</button>`).join("");
    this.el.options.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", () => {
      if (this.phase !== "choose") return;
      this.choice = Number(btn.dataset.i);
      this.finish();
    }));
    clock(8, this.el.timer, this.el.bar, () => this.finish());
  },
  finish() {
    if (this.phase !== "choose") return;
    this.phase = "idle";
    stopClock();
    const item = this.queue[this.index];
    const ok = this.choice === item.answer;
    this.results.push({
      prompt: item.prompt,
      correct: item.options[item.answer],
      yours: this.choice == null ? "" : item.options[this.choice],
      score: ok ? 100 : 0,
    });
    this.index += 1;
    if (this.index < this.queue.length) this.play();
    else this.report();
  },
  report() {
    this.el.options.innerHTML = "";
    this.el.start.disabled = false;
    this.el.start.textContent = "Start new set";
    const right = this.results.filter((r) => r.score === 100).length;
    const blocks = this.results.map((r, i) => `<article class="report-item">
      <div class="score-line"><span class="badge">${i + 1}</span><span class="badge ${r.score ? "ok" : "bad"}">${r.score ? "Correct" : "Incorrect"}</span></div>
      <p>${api().escapeHtml(r.prompt)}</p>
      <p><span class="report-label">Correct</span> ${api().escapeHtml(r.correct)}</p>
      <p><span class="report-label">Yours</span> ${r.yours ? api().escapeHtml(r.yours) : '<span class="muted">(no answer)</span>'}</p>
    </article>`).join("");
    this.el.status.textContent = "Set complete.";
    showReport(this.el.summary, `Response selection: ${right}/${this.results.length}`, blocks, "Start new set", () => this.start());
  },
};

const Listen = {
  queue: [], index: 0, qIndex: 0, results: [], phase: "idle",
  init() {
    this.el = {
      progress: api().$("#ls-progress"), timer: api().$("#ls-timer"), bar: api().$("#ls-bar"),
      status: api().$("#ls-status"), question: api().$("#ls-question"), answer: api().$("#ls-answer"),
      start: api().$("#ls-start"), done: api().$("#ls-done"), summary: api().$("#ls-summary"),
    };
    this.el.start.addEventListener("click", () => this.start());
    this.el.done.addEventListener("click", () => this.finish());
  },
  start() {
    stopAudio();
    const taken = practiceQueue(api().state.data.listen, "listen", 2);
    this.queue = taken.picked;
    this.restarted = taken.restarted;
    this.index = 0;
    this.results = [];
    this.el.summary.classList.add("hidden");
    this.el.start.disabled = true;
    this.play();
  },
  play() {
    this.phase = "listen";
    this.qIndex = 0;
    this.el.progress.textContent = `Story ${this.index + 1} of ${this.queue.length}`;
    this.el.question.classList.add("hidden");
    this.el.answer.value = "";
    this.el.answer.readOnly = true;
    this.el.done.disabled = true;
    this.el.status.textContent = "Listen to the story.";
    this.el.status.className = "status live";
    noteRestart(this.el.status, this.restarted && this.index === 0);
    speak(this.queue[this.index].text, () => this.ask(), 0.8);
  },
  ask() {
    if (this.phase !== "listen" && this.phase !== "answer") return;
    this.phase = "answer";
    const q = this.queue[this.index].questions[this.qIndex];
    this.el.question.textContent = q.q;
    this.el.question.classList.remove("hidden");
    this.el.answer.value = "";
    this.el.answer.readOnly = false;
    this.el.answer.focus();
    this.el.done.disabled = false;
    this.el.status.textContent = `Question ${this.qIndex + 1} of 3. You have 20 seconds.`;
    clock(20, this.el.timer, this.el.bar, () => this.finish());
  },
  finish() {
    if (this.phase !== "answer") return;
    stopClock();
    const story = this.queue[this.index];
    const q = story.questions[this.qIndex];
    const yours = this.el.answer.value;
    const ok = api().matchesKeys(yours, q.keys);
    this.results.push({ title: story.title, q: q.q, correct: q.answer || q.keys[0].split("|")[0], yours, score: ok ? 100 : 0 });
    this.qIndex += 1;
    if (this.qIndex < story.questions.length) this.ask();
    else {
      this.index += 1;
      if (this.index < this.queue.length) this.play();
      else this.report();
    }
  },
  report() {
    this.phase = "idle";
    this.el.done.disabled = true;
    this.el.start.disabled = false;
    this.el.start.textContent = "Start new set";
    const right = this.results.filter((r) => r.score === 100).length;
    const blocks = this.results.map((r, i) => `<article class="report-item">
      <div class="score-line"><span class="badge">${i + 1}</span><span class="badge ${r.score ? "ok" : "bad"}">${r.score ? "Correct" : "Incorrect"}</span></div>
      <p>${api().escapeHtml(r.q)}</p>
      <p><span class="report-label">A good answer includes</span> ${api().escapeHtml(r.correct)}</p>
      <p><span class="report-label">Yours</span> ${r.yours.trim() ? api().escapeHtml(r.yours) : '<span class="muted">(no answer)</span>'}</p>
    </article>`).join("");
    this.el.status.textContent = "Set complete.";
    showReport(this.el.summary, `Passage comprehension: ${right}/${this.results.length}`, blocks, "Start new set", () => this.start());
  },
};

const Situations = {
  queue: [], index: 0, results: [], phase: "idle",
  init() {
    this.el = {
      progress: api().$("#si-progress"), timer: api().$("#si-timer"), bar: api().$("#si-bar"),
      status: api().$("#si-status"), prompt: api().$("#si-prompt"), answer: api().$("#si-answer"),
      start: api().$("#si-start"), voice: api().$("#si-voice"), done: api().$("#si-done"), summary: api().$("#si-summary"),
    };
    this.el.start.addEventListener("click", () => this.start());
    this.el.done.addEventListener("click", () => this.finish());
    this.el.voice.addEventListener("click", () => { if (this.phase === "speak") dictate(this.el.answer); });
  },
  start() {
    stopAudio();
    const taken = practiceQueue(api().state.data.situations, "situations", 2);
    this.queue = taken.picked;
    this.restarted = taken.restarted;
    this.index = 0;
    this.results = [];
    this.el.summary.classList.add("hidden");
    this.el.start.disabled = true;
    this.prepare();
  },
  prepare() {
    this.phase = "prep";
    const item = this.queue[this.index];
    this.el.progress.textContent = `Situation ${this.index + 1} of ${this.queue.length}`;
    this.el.prompt.textContent = item.text;
    this.el.prompt.classList.remove("hidden");
    this.el.answer.value = "";
    this.el.answer.readOnly = true;
    this.el.done.disabled = true;
    this.el.voice.disabled = true;
    this.el.status.textContent = "Read the situation. You have 10 seconds to think.";
    noteRestart(this.el.status, this.restarted && this.index === 0);
    this.el.status.className = "status live";
    speak(item.text, () => {}, 0.9);
    clock(10, this.el.timer, this.el.bar, () => this.speak());
  },
  speak() {
    if (this.phase !== "prep") return;
    this.phase = "speak";
    this.el.answer.readOnly = false;
    this.el.done.disabled = false;
    this.el.voice.disabled = false;
    this.el.status.textContent = "Speak your reply. You have 60 seconds.";
    clock(60, this.el.timer, this.el.bar, () => this.finish());
    dictate(this.el.answer);
  },
  finish() {
    if (this.phase !== "speak") return;
    this.phase = "idle";
    stopClock();
    const item = this.queue[this.index];
    const yours = this.el.answer.value;
    const missed = item.points.filter((p) => !api().matchesKeys(yours, p.keys));
    const hit = item.points.length - missed.length;
    this.results.push({ item, yours, score: Math.round((hit / item.points.length) * 100), missed });
    this.index += 1;
    if (this.index < this.queue.length) this.prepare();
    else this.report();
  },
  report() {
    closePracticeVoice();
    this.el.done.disabled = true;
    this.el.voice.disabled = true;
    this.el.start.disabled = false;
    this.el.start.textContent = "Start new set";
    const avg = Math.round(this.results.reduce((s, r) => s + r.score, 0) / this.results.length);
    const blocks = this.results.map((r, i) => `<article class="report-item">
      <div class="score-line"><span class="badge">${i + 1}</span><span class="badge ${r.score >= 70 ? "ok" : "bad"}">${api().escapeHtml(r.item.title)} · ${r.score}%</span></div>
      <p>${api().escapeHtml(r.item.text)}</p>
      <p><span class="report-label">Yours</span><br>${r.yours.trim() ? api().escapeHtml(r.yours) : '<span class="muted">(nothing captured)</span>'}</p>
      <p><span class="report-label">You could have said</span><br>${api().escapeHtml(r.item.model || "")}</p>
      ${r.missed.length ? `<ul class="checklist">${r.missed.map((p) => `<li class="bad"><span class="mark">&#10007;</span><span>${api().escapeHtml(p.text)}</span></li>`).join("")}</ul>` : `<p class="note">The required points were covered.</p>`}
    </article>`).join("");
    this.el.status.textContent = "Set complete.";
    showReport(this.el.summary, `Speaking situations: ${avg}%`, blocks, "Start new set", () => this.start());
  },
};

function noteRestart(el, restarted) {
  if (!restarted) return;
  el.textContent = "You have seen every item in this section, so this set is starting again. " + el.textContent;
  el.className = "status warn";
}

function freshTake(pool, key, count, seen = new Set()) {
  return api().takeQuestions(pool, key, count, seen);
}

function practiceQueue(pool, key, count) {
  return freshTake(pool, key, count);
}

const SPOKEN = new Set(["repeat", "situation", "story", "read"]);

const MockHistory = {
  key: "versant.mock.results.v1",
  init() {
    this.el = { list: api().$("#mh-list"), detail: api().$("#mh-detail"), status: api().$("#mh-status") };
    api().$("#fm-history").addEventListener("click", () => this.open());
    this.render();
  },
  read() {
    const saved = api().loadStore(this.key, []);
    return Array.isArray(saved) ? saved.filter((x) => x && Array.isArray(x.rows)) : [];
  },
  save(kind, rows, id) {
    if (!rows.length) return;
    const history = this.read();
    const record = { id: id || `${Date.now()}-${Math.random().toString(36).slice(2)}`, kind,
      completedAt: new Date().toISOString(),
      score: Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length),
      rows: JSON.parse(JSON.stringify(rows)) };
    if (history.some((x) => x.id === record.id)) return;
    try {
      api().saveStore(this.key, [record, ...history]);
      this.render();
    } catch {
      // Keep the current report usable even if browser storage is full/disabled.
      if (this.el) this.el.status.textContent = "This result could not be saved because browser storage is unavailable or full. Keep the current report open.";
      return false;
    }
    return true;
  },
  open() {
    this.render();
    api().$("[data-tab=results]").click();
  },
  render() {
    if (!this.el) return;
    const history = this.read();
    this.el.list.innerHTML = history.length ? history.map((record, index) =>
      `<button type="button" class="btn" data-result="${index}">${api().escapeHtml(record.kind)} · ${api().escapeHtml(new Date(record.completedAt).toLocaleString())} · ${record.score}% · ${record.rows.length} questions</button>`
    ).join("") : '<p class="muted">No saved mocks yet. Finish a mock test to see its results here.</p>';
    this.el.list.querySelectorAll("[data-result]").forEach((button) => button.addEventListener("click", () => this.view(history[Number(button.dataset.result)])));
  },
  questionHtml(rows) {
    return rows.map((row, i) => `<article class="report-item">
      <div class="score-line"><span class="badge">Question ${i + 1} · ${api().escapeHtml(row.section)}</span><span class="badge ${row.score >= 80 ? "ok" : "bad"}">${row.score}%</span></div>
      <p class="history-answer"><span class="report-label">Question</span><br>${api().escapeHtml(row.question || row.correct)}</p>
      ${row.context ? `<details class="history-context"><summary>Passage / source text</summary><p class="history-answer">${api().escapeHtml(row.context)}</p></details>` : ""}
      <p class="history-answer"><span class="report-label">My answer</span><br>${row.yours && row.yours.trim() ? api().escapeHtml(row.yours) : '<span class="muted">(no answer)</span>'}</p>
      <p class="history-answer"><span class="report-label">${api().escapeHtml(row.expectedLabel || "Correct answer")}</span><br>${api().escapeHtml(row.correct)}</p>
      ${row.note ? `<p>${api().escapeHtml(row.note)}</p>` : ""}
    </article>`).join("");
  },
  view(record) {
    this.el.detail.innerHTML = `<h3>${api().escapeHtml(record.kind)}: ${record.score}%</h3><p class="muted">${api().escapeHtml(new Date(record.completedAt).toLocaleString())}</p>${this.questionHtml(record.rows)}`;
    this.el.detail.classList.remove("hidden");
    this.el.detail.scrollIntoView({ behavior: "smooth", block: "start" });
  },
};

const FullMock = {
  steps: [], index: 0, results: [], phase: "idle", picks: [], choice: null, built: [],
  voiceOpen: false,
  voicePending: null,
  voiceBox: null,
  init() {
    this.el = {
      home: api().$("#fm-home"), run: api().$("#fm-run"), summary: api().$("#fm-summary"),
      progress: api().$("#fm-progress"), timer: api().$("#fm-timer"), bar: api().$("#fm-bar"),
      status: api().$("#fm-status"), stage: api().$("#fm-stage"),
      voice: api().$("#fm-voice"), done: api().$("#fm-done"), start: api().$("#fm-start"),
    };
    this.el.start.addEventListener("click", () => this.start());
    this.el.done.addEventListener("click", () => this.finish());
    this.el.voice.addEventListener("click", () => {
      const input = this.el.stage.querySelector("input, textarea");
      if (!input) return;
      if (this.phase === "answer") this.armVoice(input);
    });
  },
  async start() {
    stopAudio();
    await this.closeVoice();
    this.resultId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const data = api().state.data;
    const pool = data.passages.filter((p) => p.difficulty === "moderate" || p.difficulty === "hard");
    const repeatPool = [...data.sentences.level2, ...data.sentences.level3].map((text) => ({ id: text, text }));
    const mockSeen = new Set();
    const mockTake = (items, key, count) => freshTake(items, key, count, mockSeen);
    const blanks = mockTake(data.blanks, "blanks", 5);
    const passages = mockTake(pool, "passages", 1);
    const reading = mockTake(data.reading, "reading", 1);
    const emails = mockTake(data.emails, "emails", 1);
    const dictation = mockTake(data.dictation, "dictation", 4);
    const responses = mockTake(data.responses, "responses", 4);
    const listen = mockTake(data.listen, "listen", 1);
    const repeats = mockTake(repeatPool, "repeat", 6);
    const situations = mockTake(data.situations, "situations", 1);
    const stories = mockTake(data.stories, "stories", 1);
    const pack = (taken, type, label) => taken.picked.map((item, i, arr) => ({
      type, item, label: arr.length > 1 ? `${label} ${i + 1} of ${arr.length}` : label, restarted: i === 0 && taken.restarted,
    }));
    this.steps = [
      ...pack(blanks, "blank", "Sentence completion"),
      ...pack(passages, "passage", "Passage reconstruction"),
      ...pack(reading, "reading", "Reading comprehension"),
      ...pack(emails, "email", "Email writing"),
      ...pack(dictation, "dictation", "Dictation"),
      ...pack(responses, "response", "Response selection"),
      ...pack(listen, "listen", "Passage comprehension"),
      ...pack(repeats, "repeat", "Repeat"),
      ...pack(situations, "situation", "Speaking situation"),
      ...pack(stories, "story", "Story retelling"),
    ];
    this.index = 0;
    this.results = [];
    this.el.home.classList.add("hidden");
    this.el.summary.classList.add("hidden");
    this.el.run.classList.remove("hidden");
    this.begin();
  },
  current() { return this.steps[this.index]; },
  begin() {
    const step = this.current();
    this.phase = "live";
    this.el.progress.textContent = step.label;
    this.el.voice.classList.add("hidden");
    this.el.done.classList.remove("hidden");
    this.el.done.disabled = false;
    if (step.type === "blank") this.beginBlank(step.item);
    else if (step.type === "passage") this.beginPassage(step.item);
    else if (step.type === "reading") this.beginReading(step.item);
    else if (step.type === "email") this.beginEmail(step.item);
    else if (step.type === "dictation") this.beginDictation(step.item);
    else if (step.type === "response") this.beginResponse(step.item);
    else if (step.type === "listen") this.beginListen(step.item);
    else if (step.type === "repeat") this.beginRepeat(step.item);
    else if (step.type === "situation") this.beginSituation(step.item);
    else if (step.type === "story") this.beginStory(step.item);
    if (step.restarted) {
      this.el.stage.insertAdjacentHTML("afterbegin", `<p class="status warn">You have seen every item in this section, so this pool is starting again.</p>`);
    }
  },
  inputBox(placeholder, area) {
    const tag = area ? "textarea" : "input";
    this.el.stage.innerHTML = `<${tag} id="fm-answer" ${area ? 'rows="8"' : 'type="text"'} autocomplete="off" spellcheck="false" placeholder="${placeholder}"></${tag}>`;
    return this.el.stage.querySelector("#fm-answer");
  },
  armVoice(box) {
    this.el.voice.classList.remove("hidden");
    this.el.voice.textContent = "Start voice typing (Win+H)";
    if (this.voicePending) {
      return this.voiceBox === box ? this.voicePending : this.voicePending.then(() => this.armVoice(box));
    }
    this.voiceBox = box;
    this.voicePending = (async () => {
      await focusAnswerBox(box);
      // The native helper also handles focus held by this run's Win+H panel.
      return api().ensureVoiceTyping(this.voiceOpen);
    })().then(async (res) => {
      if (res.panelOpen || res.ok) this.voiceOpen = true;
      if (box.isConnected !== false && this.phase === "answer" && this.el.stage.querySelector("#fm-answer") === box) await focusAnswerBox(box);
      const note = dictationNote(res);
      if (note && this.phase === "answer") {
        this.el.status.textContent = note;
        this.el.status.className = "status warn";
      }
      return res;
    }).finally(() => { this.voicePending = null; });
    return this.voicePending;
  },
  async closeVoice() {
    if (this.voicePending) await this.voicePending;
    if (!this.voiceOpen) return Promise.resolve();
    this.voiceOpen = false;
    return api().pressWinH(0);
  },
  beginRead(sentence) {
    this.el.stage.innerHTML = `<p class="passage">${api().escapeHtml(sentence)}</p><input id="fm-answer" type="text" autocomplete="off" spellcheck="false" placeholder="Your reading appears here">`;
    const box = this.el.stage.querySelector("#fm-answer");
    this.phase = "answer";
    this.el.status.textContent = "Read the sentence aloud.";
    this.el.status.className = "status live";
    this.armVoice(box).then(() => {
      if (this.phase === "answer") clock(15, this.el.timer, this.el.bar, () => this.finish());
    });
  },
  beginRepeat(sentence) {
    const text = sentence.text || sentence;
    this.pending = text;
    this.el.done.disabled = true;
    this.phase = "listen";
    this.el.stage.innerHTML = `<input id="fm-answer" type="text" readonly autocomplete="off" spellcheck="false" placeholder="Listen first. Windows voice typing opens after playback.">`;
    const box = this.el.stage.querySelector("#fm-answer");
    this.el.status.textContent = "Listen. The sentence is played once.";
    this.el.status.className = "status live";
    this.el.timer.textContent = "";
    speak(text, () => {
      if (this.phase !== "listen") return;
      this.phase = "answer";
      box.readOnly = false;
      this.el.done.disabled = false;
      this.el.status.textContent = "Repeat the sentence.";
      box.focus();
      this.armVoice(box).then(() => {
        if (this.phase === "answer") {
          clock(20, this.el.timer, this.el.bar, () => this.finish());
        }
      });
    });
  },
  beginJumble(item) {
    this.built = [];
    this.jumbleOrder = api().shuffle([0, 1, 2]);
    this.el.stage.innerHTML = `<div id="fm-bank" class="chips"></div><p class="field-label">Your sentence</p><div id="fm-built" class="chips chips-built"></div>`;
    this.phase = "answer";
    this.el.status.textContent = "Tap the phrases in the correct order.";
    this.el.status.className = "status live";
    this.paintJumble();
    clock(15, this.el.timer, this.el.bar, () => this.finish());
  },
  paintJumble() {
    const item = this.current().item;
    const chip = (text, index) => `<button type="button" class="chip" data-i="${index}">${api().escapeHtml(text)}</button>`;
    const bank = this.el.stage.querySelector("#fm-bank");
    const built = this.el.stage.querySelector("#fm-built");
    bank.innerHTML = this.jumbleOrder.filter((i) => !this.built.includes(i)).map((i) => chip(item.parts[i], i)).join("");
    built.innerHTML = this.built.map((i) => chip(item.parts[i], i)).join("") || `<span class="muted">Tap a phrase above.</span>`;
    bank.querySelectorAll(".chip").forEach((btn) => btn.addEventListener("click", () => {
      if (this.phase !== "answer") return;
      this.built.push(Number(btn.dataset.i));
      this.paintJumble();
    }));
    built.querySelectorAll(".chip").forEach((btn) => btn.addEventListener("click", () => {
      if (this.phase !== "answer") return;
      this.built = this.built.filter((i) => i !== Number(btn.dataset.i));
      this.paintJumble();
    }));
  },
  beginStory(story) {
    this.el.stage.innerHTML = "";
    this.el.done.disabled = true;
    this.phase = "listen";
    this.el.status.textContent = "Listen to the story.";
    this.el.status.className = "status live";
    speak(story.text, () => {
      if (this.phase !== "listen") return;
      const box = this.inputBox("Retell the story in your own words.", true);
      this.phase = "answer";
      this.el.done.disabled = false;
      this.el.status.textContent = "Retell what you heard. You have 30 seconds.";
      this.armVoice(box).then(() => {
        if (this.phase === "answer") clock(30, this.el.timer, this.el.bar, () => this.finish());
      });
    }, 0.8);
  },
  beginBlank(item) {
    this.el.stage.innerHTML = `<p class="passage">${api().escapeHtml(item.text)}</p><input id="fm-answer" type="text" autocomplete="off" spellcheck="false" placeholder="Type the missing word">`;
    this.phase = "answer";
    this.el.status.textContent = "Type the missing word. You have 25 seconds.";
    this.el.status.className = "status live";
    this.el.stage.querySelector("#fm-answer").focus();
    clock(25, this.el.timer, this.el.bar, () => this.finish());
  },
  beginReading(passage) {
    const questions = passage.questions.slice(0, 2);
    this.readingQuestions = questions;
    this.picks = questions.map(() => null);
    this.el.stage.innerHTML = `<div class="passage">${api().escapeHtml(passage.text)}</div>` + questions.map((question, qi) => `
      <div class="q-block"><p><strong>${qi + 1}. ${api().escapeHtml(question.q)}</strong></p>
      <div class="options">${question.options.map((opt, oi) => `<button type="button" class="btn option" data-q="${qi}" data-o="${oi}">${api().escapeHtml(opt)}</button>`).join("")}</div></div>`).join("");
    this.phase = "answer";
    this.el.status.textContent = "Answer both questions. You have 3 minutes.";
    this.el.status.className = "status live";
    this.el.stage.querySelectorAll(".option").forEach((btn) => btn.addEventListener("click", () => {
      if (this.phase !== "answer") return;
      this.picks[Number(btn.dataset.q)] = Number(btn.dataset.o);
      btn.parentElement.querySelectorAll(".option").forEach((b) => b.classList.toggle("selected", b === btn));
    }));
    clock(180, this.el.timer, this.el.bar, () => this.finish());
  },
  beginDictation(item) {
    this.phase = "listen";
    this.el.stage.innerHTML = "";
    this.el.done.disabled = true;
    this.el.status.textContent = "Listen. You will hear the sentence once.";
    this.el.status.className = "status live";
    speak(item.text, () => {
      if (this.phase !== "listen") return;
      this.phase = "answer";
      const box = this.inputBox("Type the sentence exactly.");
      this.el.done.disabled = false;
      this.el.status.textContent = "Type what you heard. You have 25 seconds.";
      clock(25, this.el.timer, this.el.bar, () => this.finish());
      box.focus();
    });
  },
  beginResponse(item) {
    this.choice = null;
    this.phase = "listen";
    this.el.stage.innerHTML = "";
    this.el.done.classList.add("hidden");
    this.el.status.textContent = "Listen to the sentence.";
    this.el.status.className = "status live";
    speak(item.prompt, () => {
      if (this.phase !== "listen") return;
      this.phase = "answer";
      this.el.stage.innerHTML = `<p class="passage">${api().escapeHtml(item.prompt)}</p><div class="options">${item.options.map((opt, i) => `<button type="button" class="btn option" data-i="${i}">${"ABC"[i]}. ${api().escapeHtml(opt)}</button>`).join("")}</div>`;
      this.el.status.textContent = "Choose the best reply. You have 8 seconds.";
      this.el.stage.querySelectorAll(".option").forEach((btn) => btn.addEventListener("click", () => {
        if (this.phase !== "answer") return;
        this.choice = Number(btn.dataset.i);
        this.finish();
      }));
      clock(8, this.el.timer, this.el.bar, () => this.finish());
    });
  },
  beginListen(item) {
    this.listenQ = 0;
    this.listenAnswers = [];
    this.phase = "listen";
    this.el.stage.innerHTML = "";
    this.el.done.disabled = true;
    this.el.status.textContent = "Listen to the story.";
    this.el.status.className = "status live";
    speak(item.text, () => this.askListen(), 0.8);
  },
  askListen() {
    const q = this.current().item.questions[this.listenQ];
    this.phase = "answer";
    this.el.stage.innerHTML = `<p class="passage">${api().escapeHtml(q.q)}</p><input id="fm-answer" type="text" autocomplete="off" spellcheck="false" placeholder="Type a short answer">`;
    this.el.done.classList.remove("hidden");
    this.el.done.disabled = false;
    this.el.status.textContent = `Question ${this.listenQ + 1} of 3. You have 20 seconds.`;
    this.el.stage.querySelector("#fm-answer").focus();
    clock(20, this.el.timer, this.el.bar, () => this.finish());
  },
  beginSituation(item) {
    this.phase = "prep";
    this.el.done.disabled = true;
    this.el.stage.innerHTML = `<div class="prompt"><p>${api().escapeHtml(item.text)}</p></div><textarea id="fm-answer" rows="6" disabled placeholder="Your reply appears here"></textarea>`;
    this.el.status.textContent = "Read the situation. You have 10 seconds to think.";
    this.el.status.className = "status live";
    speak(item.text, () => {}, 0.9);
    clock(10, this.el.timer, this.el.bar, () => {
      if (this.phase !== "prep") return;
      this.phase = "answer";
      const box = this.el.stage.querySelector("#fm-answer");
      box.disabled = false;
      this.el.done.disabled = false;
      this.el.status.textContent = "Speak your reply. You have 60 seconds.";
      this.armVoice(box).then(() => {
        if (this.phase === "answer") clock(60, this.el.timer, this.el.bar, () => this.finish());
      });
    });
  },
  beginPassage(passage) {
    this.passagePhase = "read";
    this.el.stage.innerHTML = `<div class="passage">${api().escapeHtml(passage.text)}</div>`;
    this.el.done.classList.add("hidden");
    this.phase = "read";
    this.el.status.textContent = "Read. The passage will disappear.";
    this.el.status.className = "status live";
    clock(30, this.el.timer, this.el.bar, () => {
      this.passagePhase = "write";
      this.phase = "answer";
      const box = this.inputBox("Rewrite the passage in your own words. Keep the details.", true);
      this.el.stage.querySelector(".passage")?.remove();
      this.el.done.classList.remove("hidden");
      this.el.status.textContent = "Write what you remember.";
      clock(90, this.el.timer, this.el.bar, () => this.finish());
      box.focus();
    });
  },
  beginEmail(email) {
    this.el.stage.innerHTML = `<div class="prompt"><div class="to">To: <strong>${api().escapeHtml(email.to)}</strong>, ${api().escapeHtml(email.toRole)}</div>
      <p>${api().escapeHtml(email.situation)}</p><ol>${email.points.map((p) => `<li>${api().escapeHtml(p.text)}</li>`).join("")}</ol></div>
      <textarea id="fm-answer" rows="8" spellcheck="false" placeholder="Dear ...,"></textarea>`;
    this.phase = "answer";
    this.el.status.textContent = "Write the email. Aim for at least 100 words.";
    this.el.status.className = "status live";
    clock(540, this.el.timer, this.el.bar, () => this.finish());
  },
  answerValue() {
    const box = this.el.stage.querySelector("#fm-answer");
    return box ? box.value : "";
  },
  push(section, correct, yours, score, note, details = {}) {
    const step = this.current();
    const item = step.item;
    let question = item.text || item.prompt || correct;
    let context = "";
    let expectedLabel = "Correct answer";
    if (step.type === "email") {
      question = `To: ${item.to}, ${item.toRole}\n${item.situation}\n${item.points.map((p, i) => `${i + 1}. ${p.text}`).join("\n")}`;
      expectedLabel = "Expected answer (sample email)";
    } else if (step.type === "situation") {
      question += `\n${item.points.map((p, i) => `${i + 1}. ${p.text}`).join("\n")}`;
      expectedLabel = "Expected answer (sample reply)";
    } else if (step.type === "story" || step.type === "passage") {
      question = step.type === "story" ? "Retell the story in your own words." : "Reconstruct the passage in your own words, keeping the details.";
      context = item.text;
      expectedLabel = "Expected content (original text)";
    } else if (step.type === "response") {
      question = `${item.prompt}\n${item.options.map((option, i) => `${"ABC"[i]}. ${option}`).join("\n")}`;
    }
    this.results.push({ section, correct, yours, score, note: note || "", question, context, expectedLabel, ...details });
  },
  async finish() {
    if (this.phase !== "answer" && this.phase !== "live") return;
    const step = this.current();
    if (step.type === "listen" && this.listenQ < step.item.questions.length - 1) {
      stopClock();
      this.listenAnswers.push(this.answerValue());
      this.listenQ += 1;
      this.askListen();
      return;
    }
    this.phase = "done";
    stopClock();
    const yours = this.answerValue();
    if (step.type === "repeat") {
      const scored = api().scoreRepeat(step.item.text, yours);
      this.push("Repeat", step.item.text, yours, scored.accuracy);
    } else if (step.type === "story") {
      const scored = storyScore(step.item, yours);
      const missed = scored.facts.filter((f) => !f.hit).map((f) => f.label).join("; ");
      this.push("Story retelling", step.item.text, yours, scored.coverage, missed ? `Missed: ${missed}` : "All key details covered");
    } else if (step.type === "blank") {
      const correct = api().blankAnswer(step.item);
      const said = yours.trim();
      this.push("Sentence completion", correct, said, api().matchesBlank(said, step.item) ? 100 : 0, step.item.text);
    } else if (step.type === "reading") {
      this.readingQuestions.forEach((question, i) => {
        const pick = this.picks[i];
        this.push("Reading comprehension", question.options[question.answer], pick == null ? "" : question.options[pick], pick === question.answer ? 100 : 0, "", {
          question: `${question.q}\n${question.options.map((option, i) => `${"ABC"[i]}. ${option}`).join("\n")}`, context: step.item.text,
        });
      });
    } else if (step.type === "passage") {
      const scored = api().Passage.scoreAttempt(step.item, yours);
      const missed = scored.facts.filter((f) => !f.hit).map((f) => f.label).join("; ");
      this.push("Passage reconstruction", step.item.text, yours, scored.coverage, missed ? `Missed: ${missed}` : "All key details covered");
    } else if (step.type === "dictation") {
      const scored = api().scoreRepeat(step.item.text, yours);
      this.push("Dictation", step.item.text, yours, scored.accuracy, punctuationNote(step.item.text, yours));
    } else if (step.type === "response") {
      const correct = step.item.options[step.item.answer];
      this.push("Response selection", correct, this.choice == null ? "" : step.item.options[this.choice], this.choice === step.item.answer ? 100 : 0, step.item.prompt);
    } else if (step.type === "listen") {
      const answers = this.listenAnswers.concat(yours);
      step.item.questions.forEach((q, i) => {
        const said = answers[i] || "";
        this.push("Passage comprehension", q.answer || q.keys[0].split("|")[0], said, api().matchesKeys(said, q.keys) ? 100 : 0, "", { question: q.q, context: step.item.text });
      });
    } else if (step.type === "situation") {
      const missed = step.item.points.filter((p) => !api().matchesKeys(yours, p.keys));
      const hit = step.item.points.length - missed.length;
      this.push("Speaking situations", step.item.model || step.item.text, yours, Math.round((hit / step.item.points.length) * 100), missed.length ? `Missed: ${missed.map((p) => p.text).join("; ")}` : "The required points were covered");
    } else {
      const checks = api().emailChecks(yours, step.item, true);
      const points = checks.filter((c) => c.label.startsWith("Point "));
      const hit = points.filter((c) => c.status === "ok").length;
      const words = api().countWords(yours);
      this.push("Email writing", step.item.model, yours, Math.round((hit / points.length) * 100), `${hit}/${points.length} points, ${words} words`);
    }
    this.index += 1;
    const next = this.steps[this.index];
    const leavingSpoken = SPOKEN.has(step.type) && (!next || !SPOKEN.has(next.type));
    const go = () => {
      if (this.index >= this.steps.length) {
        this.report();
        return;
      }
      if (next.type !== step.type) this.bridge(next);
      else this.begin();
    };
    if (leavingSpoken) this.closeVoice().then(go);
    else go();
  },
  bridge(next) {
    const info = {
      read: ["Reading aloud", "Read the sentence on the screen. You have 15 seconds."],
      repeat: ["Repeat sentences", "Listen once, then repeat the sentence."],
      jumble: ["Jumbled sentences", "Put the three phrases in order. You have 15 seconds."],
      story: ["Story retelling", "Listen once, then retell the story in 30 seconds."],
      blank: ["Sentence completion", "Type the missing word. You have 25 seconds."],
      reading: ["Reading comprehension", "Read the passage and answer two questions. You have 3 minutes."],
      passage: ["Passage reconstruction", "Read for 30 seconds, then write for 90 seconds."],
      email: ["Email writing", "Write a professional email. You have 9 minutes."],
      dictation: ["Dictation", "Hear a sentence once and type it. You have 25 seconds."],
      response: ["Response selection", "Choose the best reply. You have 8 seconds."],
      listen: ["Passage comprehension", "Listen to a story, then answer three questions."],
      situation: ["Speaking situations", "You have 10 seconds to think, then 60 seconds to speak."],
    }[next.type];
    this.phase = "bridge";
    this.el.done.disabled = true;
    this.el.voice.classList.add("hidden");
    this.el.progress.textContent = "Next section";
    this.el.status.textContent = "";
    this.el.stage.innerHTML = `<h2>Next: ${api().escapeHtml(info[0])}</h2><p>${api().escapeHtml(info[1])}</p>`;
    clock(4, this.el.timer, this.el.bar, () => {
      if (this.phase !== "bridge") return;
      this.begin();
    });
  },
  report() {
    this.el.run.classList.add("hidden");
    const saved = MockHistory.save("Full mock", this.results, this.resultId);
    const blocks = `${saved === false ? '<p class="status warn">This result could not be saved. Browser storage is unavailable or full.</p>' : ""}${MockHistory.questionHtml(this.results)}`;
    const overall = Math.round(this.results.reduce((s, r) => s + r.score, 0) / this.results.length);
    showReport(this.el.summary, `Full mock: ${overall}%`, blocks, "Start new mock", () => this.start());
    this.el.summary.insertAdjacentHTML("beforeend", '<button id="fm-past-results" type="button" class="btn">View past mock results</button>');
    this.el.summary.querySelector("#fm-past-results").addEventListener("click", () => MockHistory.open());
  },
};

window.VersantSections = {
  saveMock(kind, rows, id) { return MockHistory.save(kind, rows, id); },
  leaveMock() {
    return FullMock.closeVoice();
  },
  leavePracticeVoice: closePracticeVoice,
  start() {
    ReadAloud.init();
    Jumble.init();
    Stories.init();
    Blanks.init();
    Reading.init();
    Dictation.init();
    Responses.init();
    Listen.init();
    Situations.init();
    FullMock.init();
    MockHistory.init();
  },
};
