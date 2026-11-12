import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from database_qa_service import fetch_postgres_driver


class DriverDownloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.destination = Path(self.directory.name) / "postgresql.jar"
        self.destination.write_bytes(b"existing driver")
        self.bytes = b"pinned QA driver test fixture"
        self.artifact = dict(version="fixture", size=len(self.bytes),
                             sha256=hashlib.sha256(self.bytes).hexdigest(),
                             url="https://repo.maven.apache.org/maven2/org/postgresql/fixture.jar")
        catalog = patch.object(Path, "read_text", return_value=json.dumps(
            dict(drivers=dict(postgresql=self.artifact))))
        catalog.start()
        self.addCleanup(catalog.stop)

    def write_download(self, command, content):
        Path(command[command.index("--output") + 1]).write_bytes(content)

    def test_primary_download_is_verified_before_replacing_existing_driver(self):
        with patch("database_qa_service.subprocess.run", side_effect=lambda command, **kwargs:
                   self.write_download(command, self.bytes)) as run:
            report = fetch_postgres_driver(self.destination)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(report["sourceURL"], self.artifact["url"])
        self.assertEqual(report["attemptedURLs"], [self.artifact["url"]])
        self.assertEqual(self.destination.read_bytes(), self.bytes)

    def test_dns_failure_discards_partial_bytes_and_uses_verified_central_mirror(self):
        def download(command, **kwargs):
            if command[-1] == self.artifact["url"]:
                self.write_download(command, b"partial")
                raise subprocess.CalledProcessError(6, command)
            self.assertFalse(Path(command[command.index("--output") + 1]).exists())
            self.write_download(command, self.bytes)
        with patch("database_qa_service.subprocess.run", side_effect=download):
            report = fetch_postgres_driver(self.destination)
        self.assertEqual(len(report["attemptedURLs"]), 2)
        self.assertTrue(report["sourceURL"].startswith("https://repo1.maven.org/maven2/"))
        self.assertEqual(report["sha256"], self.artifact["sha256"])
        self.assertEqual(self.destination.read_bytes(), self.bytes)
        self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])

    def test_both_network_failures_leave_existing_driver_and_no_partial_file(self):
        with patch("database_qa_service.subprocess.run",
                   side_effect=subprocess.CalledProcessError(6, "curl")) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                fetch_postgres_driver(self.destination)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(self.destination.read_bytes(), b"existing driver")
        self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])

    def test_invalid_digest_fails_without_fallback_or_replacing_existing_driver(self):
        with patch("database_qa_service.subprocess.run", side_effect=lambda command, **kwargs:
                   self.write_download(command, b"x" * len(self.bytes))) as run:
            with self.assertRaisesRegex(ValueError, "integrity"):
                fetch_postgres_driver(self.destination)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(self.destination.read_bytes(), b"existing driver")

    def test_download_timeout_uses_the_same_pinned_mirror(self):
        def download(command, **kwargs):
            if command[-1] == self.artifact["url"]:
                raise subprocess.TimeoutExpired(command, kwargs["timeout"])
            self.write_download(command, self.bytes)
        with patch("database_qa_service.subprocess.run", side_effect=download):
            report = fetch_postgres_driver(self.destination)
        self.assertEqual(len(report["attemptedURLs"]), 2)
        self.assertEqual(self.destination.read_bytes(), self.bytes)


if __name__ == "__main__":
    unittest.main()
