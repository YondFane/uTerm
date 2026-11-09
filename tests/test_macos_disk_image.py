import importlib.util
from pathlib import Path
import subprocess
import unittest
import tempfile
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


class ImageCreationTests(unittest.TestCase):
    def test_silent_creation_retries_owned_output_but_remains_bounded(self):
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / 'silent.dmg'
            calls = []
            def command(arguments, **kwargs):
                calls.append(arguments)
                self.assertNotIn('-quiet', arguments)
                self.assertFalse(image.exists())
                image.write_bytes(b'partial' if len(calls) == 1 else b'complete')
                return subprocess.CompletedProcess(arguments, 1 if len(calls) == 1 else 0, b'', b'')
            attempts = []
            with patch.object(disk.subprocess, 'run', side_effect=command), patch.object(disk.time, 'sleep'):
                disk.create_disk_image(folder, image, 'QA', attempts)
            self.assertEqual(image.read_bytes(), b'complete')
            self.assertEqual([item['passed'] for item in attempts], [False, True])
            image.unlink()
            attempts = []
            silent = subprocess.CompletedProcess([], 1, b'', b'')
            with patch.object(disk.subprocess, 'run', return_value=silent) as run, patch.object(disk.time, 'sleep'):
                with self.assertRaisesRegex(RuntimeError, 'create failed'):
                    disk.create_disk_image(folder, image, 'QA', attempts)
                self.assertEqual(run.call_count, 5)
            self.assertEqual(len(attempts), 5)
            self.assertTrue(all(not item['passed'] for item in attempts))
            with patch.object(disk.subprocess, 'run', return_value=silent) as run:
                with self.assertRaisesRegex(RuntimeError, 'verify failed'):
                    disk.verify_disk_image(image, [])
                self.assertEqual(run.call_count, 1)
            permanent = subprocess.CompletedProcess([], 2, b'', b'')
            with patch.object(disk.subprocess, 'run', return_value=permanent) as run:
                with self.assertRaisesRegex(RuntimeError, 'create failed'):
                    disk.create_disk_image(folder, image, 'QA', [])
                self.assertEqual(run.call_count, 1)
            diagnostic = subprocess.CompletedProcess([], 1, b'not enough free space', b'')
            with patch.object(disk.subprocess, 'run', return_value=diagnostic) as run:
                with self.assertRaisesRegex(RuntimeError, 'not enough free space'):
                    disk.create_disk_image(folder, image, 'QA', [])
                self.assertEqual(run.call_count, 1)

    def test_busy_creation_discards_only_its_partial_output_and_retries(self):
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / 'personal 中文.dmg'
            calls = []
            def command(arguments, **kwargs):
                calls.append(arguments)
                if len(calls) == 1:
                    image.write_bytes(b'partial')
                    return subprocess.CompletedProcess(arguments, 1, b'', b'Resource busy')
                self.assertFalse(image.exists())
                image.write_bytes(b'complete')
                return subprocess.CompletedProcess(arguments, 0, b'created', b'')
            attempts = []
            with patch.object(disk.subprocess, 'run', side_effect=command), patch.object(disk.time, 'sleep'):
                disk.create_disk_image(Path(folder), image, 'Personal app', attempts)
            self.assertEqual(image.read_bytes(), b'complete')
            self.assertEqual([item['passed'] for item in attempts], [False, True])
            self.assertEqual(calls[0][-1], str(image))

    def test_existing_or_invalid_image_is_not_overwritten_or_retried(self):
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / 'existing.dmg'; image.write_bytes(b'keep')
            with patch.object(disk.subprocess, 'run') as run:
                with self.assertRaises(FileExistsError):
                    disk.create_disk_image(folder, image, 'QA', [])
                run.assert_not_called()
            self.assertEqual(image.read_bytes(), b'keep')
            image.unlink()
            invalid = subprocess.CompletedProcess([], 1, b'', b'Invalid argument')
            with patch.object(disk.subprocess, 'run', return_value=invalid) as run:
                with self.assertRaisesRegex(RuntimeError, 'Invalid argument'):
                    disk.create_disk_image(folder, image, 'QA', [])
                self.assertEqual(run.call_count, 1)

    def test_creation_busy_exhaustion_and_timeout_fail_with_diagnostics(self):
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / 'output.dmg'; attempts = []
            busy = subprocess.CompletedProcess([], 1, b'', b'Resource busy')
            with patch.object(disk.subprocess, 'run', return_value=busy) as run, patch.object(disk.time, 'sleep'):
                with self.assertRaisesRegex(RuntimeError, 'Resource busy'):
                    disk.create_disk_image(folder, image, 'QA', attempts)
                self.assertEqual(run.call_count, 5)
            self.assertEqual(len(attempts), 5)
            attempts = []
            with patch.object(disk.subprocess, 'run', side_effect=subprocess.TimeoutExpired('hdiutil', 120)):
                with self.assertRaises(subprocess.TimeoutExpired):
                    disk.create_disk_image(folder, image, 'QA', attempts)
            self.assertEqual(len(attempts), 1)


if __name__ == '__main__':
    unittest.main()
