# Practice questions and spoken answers

The question banks are JSON files in `data/`, rather than a separate database.
The bank refresh replaces the old variations of the same apology, journey,
or late-meeting scenario with original workplace situations. Each case has a
family identifier, so the email and listening versions of one case cannot
appear together in a full mock.

There are 151 email prompts, 167 passages, 155 stories, and 151 items each
for reading comprehension, listening comprehension, and speaking situations.
Sentence completion, dictation, read-aloud, jumbled sentences, and response
selection each have 100 items. Repeat sentences retain 100 warm-up, 100 level 2,
and 104 level 3 items in their original word-count bands.

Sentence completion requires a typed answer. Answers and common accepted
alternatives are stored internally; there are no choices in the practice UI
or full mock.

Question selection shares content-based history between standalone practice
and mock modes for each bank. It ignores substitutions of names, cities,
weekdays, and numbers. When a bank is exhausted, selection starts another
cycle and avoids the most recent set where the bank has enough items.
History is stored in the browser, so a different browser profile or clearing
site data starts a new history.

The full mock uses Windows voice typing (Win+H) for spoken answers. After
playback, it focuses the answer box and asks the local helper to inspect the
Windows text-input host through UI Automation. A closed panel opens with Win+H;
an identified paused microphone is invoked; a listening microphone is left alone.
Every repeat, speaking situation, and story answer checks this state, then
refocuses the answer box. The answer clock starts after this request completes.
Voice typing closes when the spoken section ends or the user changes tabs.
`voice_typing.ps1` uses accessible English labels and supported control patterns.
Windows builds or other display languages may expose different controls. Unknown
states are not toggled: a warning asks the user to resume the panel's microphone.
Successful activation is reported as `starting`, distinct from verified `listening`.
The app does not use browser speech recognition.

## Past mock results

The Past Mock Results tab saves completed full, email, passage, and repeat-only
mocks in browser local storage. Reports snapshot every question, source passage,
user answer, correct answer or sample answer, and score. Reading and listening
subquestions are saved separately. Results survive refreshes and server restarts
when using the same browser profile and server address/port. Clearing site data
removes them. Tests completed before this feature cannot be reconstructed.
Writing/speaking references are labeled as sample answers or expected content;
other valid responses can also be correct. Storage failures leave the current
report visible and show a warning.

## Research sources

These are original practice questions informed by public task formats and
workplace communication examples, rather than a collection of real exam items.

- [Pearson's official Versant Writing Test guide](https://www.pearson.com/content/dam/one-dot-com/one-dot-com/english/versant-test/Official-Test-Guide-Versant-Writing-Test-final.pdf): workplace emails, three themes, professional language, and at least 100 words.
- [British Council: English for emails](https://learnenglish.britishcouncil.org/en/english-emails): organising requests and professional correspondence.
- [British Council: asking a colleague to do something](https://learnenglish.britishcouncil.org/free-resources/writing/a2/email-ask-colleague-do-something?page=1): purpose, supporting details, and a clear deadline.
- [Microsoft voice typing guidance](https://support.microsoft.com/en-us/accessibility/windows/use-voice-typing-to-talk-instead-of-type-on-your-pc): an open voice-typing panel and active listening are separate concerns.

## Validation

Run `node tests/regressions.js` to check bank schemas, email model answers,
typed sentence completion, history and rollover, repeated full mocks, and
Win+H opening, per-answer listening checks, paused-microphone resume, refocusing,
closing, and foreground checks. `python -m unittest discover -s tests -p
"test_*.py"` tests native-helper orchestration with simulated Windows controls.

`node tests/browser-smoke.js` runs the page in a temporary headless Edge profile.
It checks typed completion and all six repeat answers, including the fourth,
using simulated Windows dictation and intercepted Win+H requests. It requires local server access and does not record audio.

`python _refresh_question_banks.py` regenerates the refreshed banks from the
authored workplace cases. Preserve any manual bank edits before regenerating.
