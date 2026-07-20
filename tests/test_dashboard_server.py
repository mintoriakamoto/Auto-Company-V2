import importlib.util
import threading
import unittest
from pathlib import Path
from unittest import mock


SERVER_PATH = Path(__file__).resolve().parents[1] / "dashboard" / "server.py"
SPEC = importlib.util.spec_from_file_location("dashboard_server", SERVER_PATH)
assert SPEC is not None
assert SPEC.loader is not None
dashboard_server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dashboard_server)


class DashboardServerTests(unittest.TestCase):
    def test_windows_not_running_maps_to_stopped(self) -> None:
        raw = """=== Windows Guardian ===
Awake guardian: STOPPED

=== Windows Autostart Task ===
Autostart: NOT CONFIGURED

=== WSL Daemon (systemd --user) ===
active
MainPID=321
ActiveState=active
SubState=running

=== Auto Company Status ===
Loop: NOT RUNNING
Daemon: ACTIVE (systemd --user auto-company.service)
ENGINE=claude
MODEL=sonnet
"""
        parsed = dashboard_server.parse_status_output(raw, system_name="Windows")
        self.assertEqual(parsed["guardian"]["state"], "stopped")
        self.assertEqual(parsed["autostart"]["state"], "not_configured")
        self.assertEqual(parsed["daemon"]["state"], "active")
        self.assertEqual(parsed["loop"]["state"], "stopped")
        self.assertIsNone(parsed["loop"]["pid"])

    def test_windows_not_installed_daemon_maps_correctly(self) -> None:
        raw = """=== Windows Guardian ===
Awake guardian: RUNNING (PID 45)

=== Windows Autostart Task ===
Autostart: CONFIGURED (AutoCompany-WSL-Start)

=== WSL Daemon (systemd --user) ===
auto-company.service: not installed

=== Auto Company Status ===
Loop: RUNNING (PID 77)
Daemon: NOT INSTALLED (systemd --user auto-company.service)
"""
        parsed = dashboard_server.parse_status_output(raw, system_name="Windows")
        self.assertEqual(parsed["guardian"]["state"], "running")
        self.assertEqual(parsed["guardian"]["pid"], 45)
        self.assertEqual(parsed["autostart"]["state"], "configured")
        self.assertEqual(parsed["daemon"]["state"], "not_installed")
        self.assertEqual(parsed["loop"]["state"], "running")
        self.assertEqual(parsed["loop"]["pid"], 77)

    def test_macos_active_configured_running_maps_correctly(self) -> None:
        raw = """=== Guardian ===
State=running
Pid=111
Raw=caffeinate -w 456

=== Daemon ===
State=active
MainPID=222
Raw=launchd agent loaded

=== Autostart ===
State=configured
Raw=LaunchAgent plist present

=== Loop ===
State=running
Pid=456
Raw=Loop running

=== State File ===
ENGINE=claude
MODEL=sonnet
LOOP_COUNT=9
ERROR_COUNT=0
LAST_RUN=2026-03-14 12:00:00
"""
        parsed = dashboard_server.parse_status_output(raw, system_name="Darwin")
        self.assertEqual(parsed["guardian"]["state"], "running")
        self.assertEqual(parsed["guardian"]["pid"], 111)
        self.assertEqual(parsed["daemon"]["state"], "active")
        self.assertEqual(parsed["daemon"]["mainPid"], 222)
        self.assertEqual(parsed["autostart"]["state"], "configured")
        self.assertEqual(parsed["loop"]["state"], "running")
        self.assertEqual(parsed["loop"]["pid"], 456)
        self.assertEqual(parsed["loop"]["engine"], "claude")
        self.assertEqual(parsed["loop"]["loopCount"], "9")

    def test_macos_inactive_configured_stopped_and_guardian_without_caffeinate(self) -> None:
        raw = """=== Guardian ===
State=stopped
Raw=Sleep guard: loop running without caffeinate

=== Daemon ===
State=inactive
Raw=LaunchAgent paused (.auto-loop-paused present)

=== Autostart ===
State=configured
Raw=LaunchAgent plist present

=== Loop ===
State=stopped
Raw=Loop stopped (stale PID 456)
"""
        parsed = dashboard_server.parse_status_output(raw, system_name="Darwin")
        self.assertEqual(parsed["guardian"]["state"], "stopped")
        self.assertEqual(parsed["daemon"]["state"], "inactive")
        self.assertEqual(parsed["autostart"]["state"], "configured")
        self.assertEqual(parsed["loop"]["state"], "stopped")

    def test_macos_not_installed_maps_correctly(self) -> None:
        raw = """=== Guardian ===
State=stopped
Raw=Sleep guard: not active

=== Daemon ===
State=not_installed
Raw=LaunchAgent plist not installed

=== Autostart ===
State=not_configured
Raw=LaunchAgent plist absent

=== Loop ===
State=stopped
Raw=Loop not running
"""
        parsed = dashboard_server.parse_status_output(raw, system_name="Darwin")
        self.assertEqual(parsed["daemon"]["state"], "not_installed")
        self.assertEqual(parsed["autostart"]["state"], "not_configured")
        self.assertEqual(parsed["loop"]["state"], "stopped")

    def test_windows_start_uses_powershell_runner(self) -> None:
        with mock.patch.object(
            dashboard_server,
            "run_powershell_script",
            return_value={"ok": True, "exitCode": 0, "elapsedMs": 1, "output": ""},
        ) as runner:
            result = dashboard_server.run_dashboard_action("start", system_name="Windows")
        self.assertTrue(result["ok"])
        runner.assert_called_once_with(
            dashboard_server.WINDOWS_START_SCRIPT, args=None, timeout=120
        )

    def test_macos_stop_uses_shell_runner_with_pause_daemon(self) -> None:
        with mock.patch.object(
            dashboard_server,
            "run_shell_script",
            return_value={"ok": True, "exitCode": 0, "elapsedMs": 1, "output": ""},
        ) as runner:
            result = dashboard_server.run_dashboard_action("stop", system_name="Darwin")
        self.assertTrue(result["ok"])
        runner.assert_called_once_with(
            dashboard_server.MACOS_STOP_SCRIPT,
            args=["--pause-daemon"],
            timeout=120,
        )

    def test_refresh_uses_status_script(self) -> None:
        with mock.patch.object(
            dashboard_server,
            "run_shell_script",
            return_value={"ok": True, "exitCode": 0, "elapsedMs": 1, "output": ""},
        ) as runner:
            dashboard_server.run_dashboard_action("refresh", system_name="Darwin")
        runner.assert_called_once_with(
            dashboard_server.MACOS_STATUS_SCRIPT, timeout=90
        )

    def test_invalid_log_tail_lines_fall_back_to_default(self) -> None:
        self.assertEqual(dashboard_server.parse_positive_int("abc", default=180), 180)
        self.assertEqual(dashboard_server.parse_positive_int("-5", default=180), 180)
        self.assertEqual(dashboard_server.parse_positive_int("12", default=180), 12)

    def test_linux_host_detected(self) -> None:
        self.assertEqual(dashboard_server.detect_host_kind("Linux"), "linux")

    def test_linux_status_maps_correctly(self) -> None:
        raw = """=== Guardian ===
State=not_applicable
Raw=No sleep guard needed under systemd on Linux

=== Daemon ===
State=active
MainPID=333
Raw=systemd --user auto-company.service active

=== Autostart ===
State=configured
Raw=systemd unit enabled

=== Loop ===
State=running
Pid=444
Raw=Loop running

=== State File ===
ENGINE=claude
MODEL=sonnet
LOOP_COUNT=12
ERROR_COUNT=1
TOTAL_COST_USD=4.2000
"""
        parsed = dashboard_server.parse_status_output(raw, system_name="Linux")
        self.assertEqual(parsed["guardian"]["state"], "not_applicable")
        self.assertEqual(parsed["daemon"]["state"], "active")
        self.assertEqual(parsed["daemon"]["mainPid"], 333)
        self.assertEqual(parsed["autostart"]["state"], "configured")
        self.assertEqual(parsed["loop"]["state"], "running")
        self.assertEqual(parsed["loop"]["pid"], 444)
        self.assertEqual(parsed["loop"]["engine"], "claude")
        self.assertEqual(parsed["loop"]["loopCount"], "12")

    def test_linux_daemon_not_installed_maps_correctly(self) -> None:
        raw = """=== Guardian ===
State=not_applicable
Raw=No sleep guard needed under systemd on Linux

=== Daemon ===
State=not_installed
Raw=systemd user unit not installed

=== Autostart ===
State=not_configured
Raw=systemd unit not installed

=== Loop ===
State=stopped
Raw=Loop not running
"""
        parsed = dashboard_server.parse_status_output(raw, system_name="Linux")
        self.assertEqual(parsed["daemon"]["state"], "not_installed")
        self.assertEqual(parsed["autostart"]["state"], "not_configured")
        self.assertEqual(parsed["loop"]["state"], "stopped")

    def test_linux_start_and_stop_use_shell_runner(self) -> None:
        with mock.patch.object(
            dashboard_server,
            "run_shell_script",
            return_value={"ok": True, "exitCode": 0, "elapsedMs": 1, "output": ""},
        ) as runner:
            dashboard_server.run_dashboard_action("start", system_name="Linux")
        runner.assert_called_once_with(
            dashboard_server.LINUX_START_SCRIPT, args=None, timeout=120
        )
        with mock.patch.object(
            dashboard_server,
            "run_shell_script",
            return_value={"ok": True, "exitCode": 0, "elapsedMs": 1, "output": ""},
        ) as runner:
            dashboard_server.run_dashboard_action("stop", system_name="Linux")
        runner.assert_called_once_with(
            dashboard_server.LINUX_STOP_SCRIPT, args=None, timeout=120
        )

    def test_unsupported_host_raises(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "only supports Windows hosts"):
            dashboard_server.detect_host_kind("SunOS")

    def test_host_header_allowlist(self) -> None:
        original = dashboard_server.ALLOWED_HOSTS
        try:
            # Empty allowlist = unconfigured = allow (unit-test mode).
            dashboard_server.ALLOWED_HOSTS = set()
            self.assertTrue(dashboard_server.host_header_allowed("evil.com"))
            # Configured: only the loopback origin passes.
            dashboard_server.ALLOWED_HOSTS = {"127.0.0.1:8787", "localhost:8787"}
            self.assertTrue(dashboard_server.host_header_allowed("127.0.0.1:8787"))
            self.assertTrue(dashboard_server.host_header_allowed("localhost:8787"))
            self.assertFalse(dashboard_server.host_header_allowed("evil.com"))
            self.assertFalse(dashboard_server.host_header_allowed(None))
            self.assertFalse(dashboard_server.host_header_allowed("attacker.example:8787"))
        finally:
            dashboard_server.ALLOWED_HOSTS = original

    def test_is_loopback_host(self) -> None:
        self.assertTrue(dashboard_server.is_loopback_host("127.0.0.1"))
        self.assertTrue(dashboard_server.is_loopback_host("::1"))
        self.assertTrue(dashboard_server.is_loopback_host("localhost"))
        self.assertFalse(dashboard_server.is_loopback_host("0.0.0.0"))
        self.assertFalse(dashboard_server.is_loopback_host("192.168.1.5"))

    def test_run_subprocess_handles_timeout(self) -> None:
        result = dashboard_server._run_subprocess(
            ["/bin/sh", "-c", "sleep 5"], timeout=1
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["exitCode"], 124)
        self.assertIn("timed out", result["output"])

    def test_run_subprocess_handles_missing_binary(self) -> None:
        result = dashboard_server._run_subprocess(
            ["/nonexistent/binary/xyz"], timeout=5
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["exitCode"], 127)
        self.assertIn("Failed to run", result["output"])


class DashboardHttpTests(unittest.TestCase):
    """End-to-end HTTP checks for the security guards."""

    @classmethod
    def setUpClass(cls) -> None:
        import http.server

        dashboard_server.ALLOWED_HOSTS = {"127.0.0.1:0", "localhost:0"}
        cls._orig_action = dashboard_server.run_dashboard_action
        cls._orig_status = dashboard_server.gather_status_payload
        dashboard_server.run_dashboard_action = lambda action, system_name=None: {
            "ok": True, "exitCode": 0, "elapsedMs": 1, "output": f"ran {action}"
        }
        dashboard_server.gather_status_payload = lambda system_name=None: {"ok": True}
        cls.server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), dashboard_server.DashboardHandler
        )
        cls.port = cls.server.server_address[1]
        dashboard_server.ALLOWED_HOSTS = {
            f"127.0.0.1:{cls.port}", f"localhost:{cls.port}"
        }
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        dashboard_server.run_dashboard_action = cls._orig_action
        dashboard_server.gather_status_payload = cls._orig_status
        dashboard_server.ALLOWED_HOSTS = set()

    def _conn(self):
        import http.client

        return http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)

    def test_bad_host_header_rejected(self) -> None:
        conn = self._conn()
        conn.request("GET", "/api/status", headers={"Host": "evil.com"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 403)
        conn.close()

    def test_status_ok_with_good_host(self) -> None:
        conn = self._conn()
        conn.request("GET", "/api/status", headers={"Host": f"127.0.0.1:{self.port}"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        self.assertIn("Content-Security-Policy", dict(resp.getheaders()))
        conn.close()

    def test_post_without_csrf_header_rejected(self) -> None:
        conn = self._conn()
        conn.request("POST", "/api/action/stop", headers={"Host": f"127.0.0.1:{self.port}"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 403)
        conn.close()

    def test_post_with_csrf_header_allowed(self) -> None:
        conn = self._conn()
        conn.request(
            "POST",
            "/api/action/stop",
            headers={
                "Host": f"127.0.0.1:{self.port}",
                "X-Requested-With": "AutoCompanyDashboard",
            },
        )
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        conn.close()

    def test_post_with_cross_origin_rejected(self) -> None:
        conn = self._conn()
        conn.request(
            "POST",
            "/api/action/stop",
            headers={"Host": f"127.0.0.1:{self.port}", "Origin": "http://evil.com"},
        )
        resp = conn.getresponse()
        self.assertEqual(resp.status, 403)
        conn.close()


if __name__ == "__main__":
    unittest.main()
