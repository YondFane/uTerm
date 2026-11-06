import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('macos_disk_image', Path(__file__).resolve().parents[1] / 'scripts/macos_disk_image.py')
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)


class ImageVerificationTests(unittest.TestCase):
    def test_busy_image_is_actually_verified_on_retry_with_original_diagnostics(self):
        attempts = []
        busy = subprocess.CompletedProcess([], 1, b'', b'Resource temporarily unavailable')
        valid = subprocess.CompletedProcess([], 0, b'checksum VALID', b'')
        with patch.object(disk.subprocess, 'run', side_effect=[busy, valid]) as run, patch.object(disk.time, 'sleep') as sleep:
            disk.verify_disk_image(Path('/tmp/qa image.dmg'), attempts)
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args.args[0], ['hdiutil', 'verify', '/tmp/qa image.dmg'])
            sleep.assert_called_once_with(.25)
        self.assertEqual([item['passed'] for item in attempts], [False, True])
        self.assertIn('temporarily unavailable', attempts[0]['stderr'])
        self.assertEqual(attempts[1]['stdout'], 'checksum VALID')

    def test_invalid_image_is_not_retried_or_accepted(self):
        attempts = []
        invalid = subprocess.CompletedProcess([], 1, b'', b'image checksum is INVALID')
        with patch.object(disk.subprocess, 'run', return_value=invalid) as run, patch.object(disk.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'INVALID'):
                disk.verify_disk_image('invalid.dmg', attempts)
            self.assertEqual(run.call_count, 1)
            sleep.assert_not_called()
        self.assertFalse(attempts[0]['passed'])

    def test_permanent_busy_and_timeout_remain_failures(self):
        attempts = []
        busy = subprocess.CompletedProcess([], 1, b'', b'Resource busy')
        with patch.object(disk.subprocess, 'run', return_value=busy) as run, patch.object(disk.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'Resource busy'):
                disk.verify_disk_image('busy.dmg', attempts)
            self.assertEqual(run.call_count, 5)
            self.assertEqual(sleep.call_count, 4)
        self.assertEqual(len(attempts), 5)
        self.assertTrue(all(not item['passed'] for item in attempts))
        attempts = []
        with patch.object(disk.subprocess, 'run', side_effect=subprocess.TimeoutExpired('hdiutil', 60)):
            with self.assertRaises(subprocess.TimeoutExpired):
                disk.verify_disk_image('timeout.dmg', attempts)
        self.assertEqual(len(attempts), 1)
        self.assertFalse(attempts[0]['passed'])


if __name__ == '__main__':
    unittest.main()
