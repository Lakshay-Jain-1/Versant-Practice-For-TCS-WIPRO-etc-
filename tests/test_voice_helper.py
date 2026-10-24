"""Test native orchestration without opening a panel or sending OS input."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class VoiceHelperTests(unittest.TestCase):
    def run_case(self, states, hint=False, foreground=True):
        user32 = MagicMock()
        user32.GetForegroundWindow.return_value = 123
        with patch.object(server, "IS_WINDOWS", True), \
             patch.object(server, "user32", user32, create=True), \
             patch.object(server, "foreground_title", return_value=server.PAGE_TITLE_MARKER if foreground else "Other app", create=True), \
             patch.object(server, "press_win_h", return_value=True, create=True) as keys, \
             patch.object(server, "inspect_voice_typing", side_effect=states) as inspect, \
             patch.object(server.time, "sleep"):
            result = server.ensure_voice_typing(hint)
            return result, keys.call_count, [call.args for call in inspect.call_args_list]

    def test_listening_does_not_toggle(self):
        result, keys, calls = self.run_case([{"state": "listening"}], True)
        self.assertTrue(result["ok"])
        self.assertEqual(keys, 0)
        self.assertEqual(calls, [()])

    def test_paused_invokes_microphone(self):
        result, keys, calls = self.run_case([{"state": "paused"}, {"state": "starting", "activated": True}], True)
        self.assertTrue(result["ok"])
        self.assertEqual(keys, 0)
        self.assertEqual(calls, [(), ("resume",)])

    def test_closed_opens_once(self):
        result, keys, _ = self.run_case([{"state": "closed"}, {"state": "listening"}])
        self.assertTrue(result["ok"])
        self.assertEqual(keys, 1)

    def test_unknown_never_toggles(self):
        result, keys, _ = self.run_case([{"state": "unknown"}], True)
        self.assertFalse(result["ok"])
        self.assertTrue(result["panelOpen"])
        self.assertEqual(keys, 0)

    def test_unavailable_existing_panel_does_not_toggle(self):
        result, keys, _ = self.run_case([{"state": "unavailable"}], True)
        self.assertEqual(result["reason"], "voice_state_unknown")
        self.assertEqual(keys, 0)

    def test_background_does_nothing(self):
        result, keys, calls = self.run_case([], foreground=False)
        self.assertEqual(result["reason"], "not_foreground")
        self.assertEqual(keys, 0)
        self.assertEqual(calls, [])

    def test_panel_focus_returns_to_its_trainer(self):
        user32 = MagicMock()
        user32.GetForegroundWindow.return_value = 123
        with patch.object(server, "IS_WINDOWS", True), \
             patch.object(server, "_voice_target", 123), \
             patch.object(server, "user32", user32, create=True), \
             patch.object(server, "foreground_title", return_value="Voice typing", create=True), \
             patch.object(server, "window_title", return_value=server.PAGE_TITLE_MARKER, create=True), \
             patch.object(server, "input_host_has_focus", return_value=True, create=True), \
             patch.object(server, "inspect_voice_typing", return_value={"state": "listening"}), \
             patch.object(server, "press_win_h", create=True) as keys:
            result = server.ensure_voice_typing(True)
            self.assertTrue(result["ok"])
            user32.SetForegroundWindow.assert_called_once_with(123)
            keys.assert_not_called()


class BrowserLaunchTests(unittest.TestCase):
    def test_default_browser_when_edge_is_missing(self):
        with patch.object(server, "IS_WINDOWS", True), \
             patch.object(server.shutil, "which", return_value=None), \
             patch.dict(server.os.environ, {}, clear=True), \
             patch.object(server.webbrowser, "open", return_value=True) as fallback, \
             patch.object(server.subprocess, "Popen") as launch:
            self.assertTrue(server.open_browser("http://127.0.0.1:8765/"))
            fallback.assert_called_once_with("http://127.0.0.1:8765/")
            launch.assert_not_called()

    def test_edge_is_preferred_when_available(self):
        with patch.object(server, "IS_WINDOWS", True), \
             patch.object(server.shutil, "which", return_value="C:/Edge/msedge.exe"), \
             patch.object(Path, "is_file", return_value=True), \
             patch.object(server.subprocess, "Popen") as launch, \
             patch.object(server.webbrowser, "open") as fallback:
            self.assertTrue(server.open_browser("http://127.0.0.1:8765/"))
            launch.assert_called_once()
            fallback.assert_not_called()


if __name__ == "__main__":
    unittest.main()
