import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("client_upgrade", Path(__file__).resolve().parents[1] / "scripts/client-upgrade-smoke.py")
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class ProgramSwapTests(unittest.TestCase):
    def test_interruption_recovers_old_program_without_changing_retained_data(self):
        with tempfile.TemporaryDirectory(prefix="uterm-native-qa-transition-") as root:
            apps = Path(root) / "Private Applications"
            apps.mkdir()
            installed, staged, previous = [apps / name for name in ["Installed.app", "Next.app", "Previous.app"]]
            for path, value in [(installed, b"historical"), (staged, b"native")]:
                path.mkdir(); (path / "program").write_bytes(value)
            data = Path(root) / "canonical.json"
            data.write_bytes(b"LATEST DRAFT DATA")
            old = upgrade.tree_digest(installed)
            with self.assertRaises(InterruptedError):
                upgrade.replace_program(installed, staged, previous, interrupt=True)
            self.assertFalse(installed.exists())
            self.assertEqual(upgrade.tree_digest(previous), old)
            upgrade.recover_program(installed, staged, previous)
            self.assertEqual(upgrade.tree_digest(installed), old)
            self.assertEqual(data.read_bytes(), b"LATEST DRAFT DATA")
            upgrade.replace_program(installed, staged, previous)
            self.assertEqual((installed / "program").read_bytes(), b"native")
            self.assertEqual((previous / "program").read_bytes(), b"historical")

    def test_foreign_profiles_and_package_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="foreign-application-") as root:
            apps = Path(root) / "Applications"; apps.mkdir()
            for name in ["Installed.app", "Next.app"]:
                (apps / name).mkdir()
            with self.assertRaises(AssertionError):
                upgrade.replace_program(apps / "Installed.app", apps / "Next.app", apps / "Previous.app")
            (apps / "Installed.app/outside").symlink_to(Path(root) / "outside")
            with self.assertRaises(AssertionError):
                upgrade.tree_digest(apps / "Installed.app")


if __name__ == "__main__":
    unittest.main()
