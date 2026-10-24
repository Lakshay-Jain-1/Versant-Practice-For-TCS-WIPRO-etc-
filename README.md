# Versant Practice Trainer

An independent, local practice app for speaking, listening, reading, and writing tasks. **This project is not affiliated with TCS.** It is also not an official Versant test or score report.

**Windows only:** this app is intended to run on Windows 10 or 11. Other operating systems are not supported.

Microsoft Edge gives the best experience. If Edge is not installed, the app opens your default browser. Chrome and other browsers with speech synthesis can work too; available voices and audio behavior vary by browser. Windows voice typing is optional: every answer can be typed.

## Requirements

- Python 3.8 or newer (Python 3.12 is used for development).
- A current desktop browser with JavaScript enabled. Microsoft Edge is recommended.
- Windows 10 or 11. Voice typing through **Win+H** also requires a working microphone.

There are **no Python packages to install**. The server uses only the Python standard library. Question banks are included in `data/`.

## Start the app

Open a terminal in this folder and run:

```powershell
python server.py
```

`py server.py` also works if the Python launcher is installed. Keep the terminal open while practising. The app serves only your computer at **http://127.0.0.1:8765/** and opens Edge when available, otherwise your default browser. If no browser opens, paste that address into any browser. Press **Ctrl+C** in the terminal to stop the server.

Useful options:

```powershell
python server.py --no-browser
python server.py --port 9000
```

With a custom port, open the address printed in the terminal. Use the same browser and port to retain your saved results.

## Voice typing and audio

The app speaks prompts using your browser's speech synthesis. Choose a voice in Repeat Sentences if several are installed. Unmute the browser and system if you cannot hear playback.

Grant microphone access and press **Win+H** once in an answer box to set up Windows voice typing. The local helper can open or resume it during spoken tasks. Keep the browser in front; the helper will not send a shortcut to another app. If voice typing is unavailable, type in the answer box and continue. The text capture and automated scores are practice feedback, not an assessment of pronunciation.

## Practice and results

Use the tabs for individual sections or choose **Full Mock** for a timed run. Completed full, Repeat Sentences, Passage Reconstruction, and Email Writing mocks appear under **Past Mock Results**. Results and question history are saved in your browser's local storage. Clearing site data, switching browser profiles, or changing the server port can make previous results unavailable in the new session.

## Troubleshooting

- **`python` is not recognized:** install Python 3.8+ and enable its PATH option, or try `py server.py`.
- **Port 8765 is busy:** run `python server.py --port 9000` and use the printed address.
- **Edge is not installed or does not open:** the default browser should open. Otherwise, manually open the printed address. No Edge installation is required.
- **No spoken audio:** check browser and system volume and try a current Edge or Chrome version.
- **Voice typing does not start:** focus the answer box and press Win+H yourself, or type the answer. Check that the microphone is working.
- **Page says practice data could not load:** start `server.py` from this project; opening `static/index.html` directly as a file does not serve the question banks.

## Development checks (optional)

Node.js is needed only for the JavaScript checks; it is not needed to run the app. Run:

```powershell
node tests/regressions.js
python -m unittest discover -s tests -p "test_*.py"
node tests/browser-smoke.js
```

The browser smoke test requires a local Edge or Chrome installation and permission to start a loopback server. You can point `VERSANT_TEST_BROWSER` to another Chromium executable. `QUESTION_BANK_NOTES.md` documents the question banks, scoring assumptions, and source material.
