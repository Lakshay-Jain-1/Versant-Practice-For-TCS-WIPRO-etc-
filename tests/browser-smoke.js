"use strict";

// Run with: node tests/browser-smoke.js
// Real Chromium browser/HTML smoke test. Windows dictation is simulated; no OS shortcuts are sent.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const browserCandidates = [
  process.env.VERSANT_TEST_BROWSER,
  ...[process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean)
    .flatMap((base) => [path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(base, "Google", "Chrome", "Application", "chrome.exe")]),
];
const browserPath = browserCandidates.find((candidate) => candidate && fs.existsSync(candidate));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.on("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch {}
    await delay(100);
  }
  throw new Error("Timed out: " + label);
}

class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Runtime.exceptionThrown") this.errors.push(message.params.exceptionDetails);
      if (!message.id) return;
      const task = this.pending.get(message.id);
      if (!task) return;
      this.pending.delete(message.id);
      clearTimeout(task.timeout);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error("DevTools timeout: " + method)); }, 8000);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
}

const instrument = `
  window.__winhEvents = [];
  document.hasFocus = () => true;
  window.__winhCalls = 0;
  window.__ensureCalls = 0;
  window.__micActivations = 0;
  window.__micPaused = false;
  window.__audioEnd = 0;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (url, ...args) => {
    if (String(url).includes('/api/voice/ensure')) {
      window.__ensureCalls++;
      const body = JSON.parse(args[0].body);
      if (!body.panelOpen) {
        window.__winhCalls++;
        window.__winhEvents.push({time: performance.now(), focus: document.activeElement?.id});
      }
      if (window.__micPaused) { window.__micActivations++; window.__micPaused = false; }
      return Promise.resolve(new Response(JSON.stringify({ok: true, panelOpen: true, state: 'listening'}), {headers: {'Content-Type': 'application/json'}}));
    }
    if (String(url).includes('/api/winh')) {
      window.__winhCalls++;
      window.__winhEvents.push({time: performance.now(), focus: document.activeElement?.id});
      return Promise.resolve(new Response(JSON.stringify({ok: true}), {headers: {'Content-Type': 'application/json'}}));
    }
    return originalFetch(url, ...args);
  };
  Object.defineProperty(window, 'speechSynthesis', {value: {
    speaking: false, pending: false,
    getVoices() { return []; },
    cancel() {}, resume() {},
    speak(utterance) { setTimeout(() => { window.__audioEnd = performance.now(); utterance.onend?.(); }, 40); }
  }});
`;

async function main() {
  assert.ok(browserPath, "Install Edge/Chrome or set VERSANT_TEST_BROWSER to a Chromium browser executable");
  const appPort = await freePort();
  const debugPort = await freePort();
  const tempRoot = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, "versant-smoke-"));
  let server, edge, tools;
  let edgeLog = "";
  let serverLog = "";
  try {
    server = spawn("python", ["server.py", "--no-browser", "--port", String(appPort)], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-2000); });
    server.stderr.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-2000); });
    await until(async () => (await fetch(`http://127.0.0.1:${appPort}/api/health`)).ok, "local server");
    const response = await fetch(`http://127.0.0.1:${appPort}/data/emails.json`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).length, 151);
    edge = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--mute-audio",
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    edge.stderr.on("data", (chunk) => { edgeLog = (edgeLog + chunk).slice(-2000); });
    const page = await until(async () => {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return pages.find((entry) => entry.type === "page");
    }, "browser DevTools");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    tools = new DevTools(socket);
    await tools.send("Page.enable");
    await tools.send("Runtime.enable");
    await tools.send("Page.addScriptToEvaluateOnNewDocument", { source: instrument });
    await tools.send("Page.navigate", { url: `http://127.0.0.1:${appPort}/` });
    await until(() => tools.evaluate("document.querySelector('#em-select')?.options.length === 151 && document.querySelector('#rs-progress')?.textContent.includes('sentence')"), "trainer boot");

    await tools.evaluate("document.querySelector('[data-tab=blanks]').click(); document.querySelector('#bl-start').click()");
    assert.equal(await tools.evaluate("document.querySelectorAll('#tab-blanks .option').length"), 0);
    assert.equal(await tools.evaluate("document.querySelector('#bl-options') === null"), true);
    await tools.evaluate("document.querySelector('#bl-answer').value = Blanks.queue[0].answer; document.querySelector('#bl-answer').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))");
    assert.equal(await tools.evaluate("Blanks.results[0].score"), 100);
    await tools.evaluate("document.querySelector('#bl-answer').value = Blanks.queue[1].answer; document.querySelector('#bl-submit').click()");
    assert.equal(await tools.evaluate("Blanks.results[1].score"), 100);

    await tools.evaluate("document.querySelector('[data-tab=full]').click(); document.querySelector('#fm-start').click()");
    await until(() => tools.evaluate("FullMock.steps.length === 25 && FullMock.phase === 'answer'"), "full mock start");
    assert.equal(await tools.evaluate("document.querySelectorAll('#fm-stage .option').length"), 0);
    await tools.evaluate("document.querySelector('#fm-answer').value = FullMock.current().item.answer; document.querySelector('#fm-done').click()");
    assert.equal(await tools.evaluate("FullMock.results[0].score"), 100);

    // Start the real repeat controller without waiting through all other sections.
    await tools.evaluate("FullMock.index = FullMock.steps.findIndex(step => step.type === 'repeat'); FullMock.begin()");
    for (let question = 1; question <= 6; question++) {
      await until(() => tools.evaluate("FullMock.phase === 'answer' && FullMock.voiceOpen && !FullMock.voicePending && document.activeElement?.id === 'fm-answer'"), "Windows dictation focus for repeat " + question);
      assert.equal(await tools.evaluate("window.__winhCalls"), 1, "later items must not toggle Win+H");
      if (question === 1) {
        assert.ok(await tools.evaluate("window.__winhEvents[0].time >= window.__audioEnd"), "Win+H opened before playback finished");
        assert.equal(await tools.evaluate("window.__winhEvents[0].focus"), "fm-answer");
      }
      const index = await tools.evaluate("FullMock.index");
      await tools.evaluate("document.querySelector('#fm-answer').value = FullMock.current().item.text");
      assert.equal(await tools.evaluate("document.querySelector('#fm-answer').value === FullMock.current().item.text"), true);
      if (question === 3) await tools.evaluate("window.__micPaused = true");
      await tools.evaluate("document.querySelector('#fm-done').click()");
      await until(() => tools.evaluate(`FullMock.index > ${index}`), "repeat scoring");
    }
    assert.equal(await tools.evaluate("FullMock.results.filter(row => row.section === 'Repeat' && row.score === 100).length"), 6);
    assert.equal(await tools.evaluate("window.__ensureCalls"), 6);
    assert.equal(await tools.evaluate("window.__micActivations"), 1, "fourth answer resumes a paused mic");
    assert.equal(await tools.evaluate("window.__winhCalls"), 1, "speaking situation must retain the open panel");

    await tools.evaluate("document.querySelector('[data-tab=email]').click(); document.querySelector('#em-mode').value = 'mock'; document.querySelector('#em-mode').dispatchEvent(new Event('change')); document.querySelector('#em-start').click()");
    assert.equal(await tools.evaluate("window.__winhCalls"), 2, "leaving the mock closes voice typing once");
    assert.equal(await tools.evaluate("Email.queue.length === 2 && skeleton(Email.queue[0]) !== skeleton(Email.queue[1])"), true);
    // Complete the email-only mock through its real scoring/report controllers.
    await tools.evaluate("Email.el.answer.value = Email.prompt.model; Email.finish(); Email.next(); Email.el.answer.value = Email.prompt.model; Email.finish()");
    assert.equal(await tools.evaluate("MockHistory.read()[0].kind"), "Email writing mock");
    assert.equal(await tools.evaluate("MockHistory.read()[0].rows.length"), 2);

    // Score every full-mock step, bypassing playback/timers only for this test.
    await tools.evaluate(`(async () => {
      FullMock.results = []; FullMock.index = 0;
      while (FullMock.index < FullMock.steps.length) {
        const step = FullMock.current(), item = step.item;
        FullMock.el.stage.innerHTML = '<textarea id="fm-answer"></textarea>';
        FullMock.phase = 'answer';
        const box = FullMock.el.stage.querySelector('#fm-answer');
        box.value = step.type === 'blank' ? blankAnswer(item) : item.model || item.text || '';
        if (step.type === 'reading') { FullMock.readingQuestions = item.questions.slice(0, 2); FullMock.picks = FullMock.readingQuestions.map(q => q.answer); }
        if (step.type === 'response') FullMock.choice = item.answer;
        if (step.type === 'listen') {
          FullMock.listenQ = item.questions.length - 1;
          FullMock.listenAnswers = item.questions.slice(0, -1).map(q => q.answer || q.keys[0].split('|')[0]);
          const last = item.questions.at(-1); box.value = last.answer || last.keys[0].split('|')[0];
        }
        await FullMock.finish();
      }
      stopClock();
    })()`);
    await until(() => tools.evaluate("MockHistory.read()[0]?.kind === 'Full mock'"), "saved full mock");
    assert.equal(await tools.evaluate("MockHistory.read()[0].rows.length"), 28);
    assert.equal(await tools.evaluate("document.querySelectorAll('#fm-summary .report-item').length"), 28);
    await tools.evaluate("document.querySelector('#fm-past-results').click(); document.querySelector('#mh-list button').click()");
    assert.equal(await tools.evaluate("document.querySelector('#tab-results').classList.contains('active')"), true);
    assert.equal(await tools.evaluate("document.querySelectorAll('#mh-detail .report-item').length"), 28);
    assert.equal(await tools.evaluate("[...document.querySelectorAll('#mh-detail .report-item')].every(item => item.textContent.includes('Question') && item.textContent.includes('My answer') && /Correct answer|Expected/.test(item.textContent))"), true);

    await tools.send("Page.reload");
    await until(() => tools.evaluate("document.querySelectorAll('#mh-list button').length === 2"), "results retained after reload");
    await tools.evaluate("document.querySelector('[data-tab=results]').click(); document.querySelector('#mh-list button').click()");
    assert.equal(await tools.evaluate("document.querySelectorAll('#mh-detail .report-item').length"), 28);
    await tools.evaluate("document.querySelector('[data-tab=repeat]').click(); Repeat.el.autoWinH.checked = true; Repeat.el.play.click()");
    await until(() => tools.evaluate("Repeat.phase === 'answering' && Repeat.dictationOpen && !Repeat.dictationOpening && document.activeElement?.id === 'rs-answer'"), "standalone repeat voice typing");
    assert.equal(await tools.evaluate("window.__winhCalls"), 1, "standalone repeat opens voice typing after playback");
    assert.ok(await tools.evaluate("window.__winhEvents[0].time >= window.__audioEnd"), "standalone repeat opened Win+H before playback ended");
    await tools.evaluate("Repeat.el.answer.value = Repeat.current; Repeat.el.check.click()");
    await until(() => tools.evaluate("Repeat.phase === 'checked' && Repeat.session.length === 1"), "standalone repeat scored");
    await tools.evaluate("Repeat.next(); window.__micPaused = true");
    await until(() => tools.evaluate("Repeat.phase === 'answering' && !Repeat.dictationOpening && window.__ensureCalls === 2"), "second standalone repeat voice check");
    assert.equal(await tools.evaluate("window.__winhCalls"), 1, "second standalone repeat must keep the panel open");
    assert.equal(await tools.evaluate("window.__micActivations"), 1, "second standalone repeat resumes a paused microphone");
    await tools.evaluate("document.querySelector('[data-tab=results]').click()");
    assert.equal(await tools.evaluate("window.__winhCalls"), 2, "leaving standalone repeat closes voice typing");
    const sections = [
      ["passage", "pr", "pr-phase"], ["email", "em", "em-phase"],
      ["read", "ra", "ra-progress"], ["jumble", "ju", "ju-progress"],
      ["story", "st", "st-progress"], ["blanks", "bl", "bl-progress"],
      ["reading", "rc", "rc-progress"], ["dictation", "dc", "dc-progress"],
      ["response", "rsp", "rsp-progress"], ["listen", "ls", "ls-progress"],
      ["situation", "si", "si-progress"],
    ];
    for (const [tab, prefix, progress] of sections) {
      await tools.evaluate(`document.querySelector('[data-tab=${tab}]').click(); document.querySelector('#${prefix}-start').click()`);
      assert.equal(await tools.evaluate(`document.querySelector('#tab-${tab}').classList.contains('active') && Boolean(document.querySelector('#${progress}')?.textContent.trim())`), true, tab);
    }
    assert.equal(tools.errors.length, 0, JSON.stringify(tools.errors));
    console.log("Browser smoke: standalone repeat opens, reuses, and closes the voice helper; all sections start; mock results and history pass.");
  } catch (error) {
    if (serverLog) console.error("Server diagnostics:", serverLog);
    if (edgeLog) console.error("Browser diagnostics:", edgeLog);
    throw error;
  } finally {
    if (tools) await tools.send("Browser.close").catch(() => {});
    if (edge && edge.exitCode === null) {
      await Promise.race([new Promise((resolve) => edge.once("exit", resolve)), delay(2000)]);
      if (edge.exitCode === null) edge.kill();
    }
    if (server) server.kill();
    // Only remove the exact temporary profile created above.
    const resolved = path.resolve(profile);
    if (resolved.startsWith(path.resolve(tempRoot) + path.sep) && path.basename(resolved).startsWith("versant-smoke-")) {
      try {
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        console.warn("Temporary browser profile still held by a browser process:", resolved);
      }
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
