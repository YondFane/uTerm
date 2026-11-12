import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
spec = importlib.util.spec_from_file_location('parity_discovery', Path(__file__).parents[1] / 'scripts/ui-parity-evidence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NativeRunDiscoveryTests(unittest.TestCase):
    head = 'a' * 40
    artifact = 'uTerm-Personal-ARM64-' + head

    def run_info(self, number, event='pull_request', **changes):
        return dict(id=number, name='macOS personal packages', head_sha=self.head, event=event,
                    status='completed', html_url=f'https://example.invalid/runs/{number}', **changes)

    def discover(self, runs, artifacts):
        requested = []
        def read(request, timeout):
            requested.append(request.full_url)
            self.assertEqual(timeout, 30)
            if '/actions/runs?' in request.full_url:
                self.assertNotIn('event=pull_request', request.full_url)
                data = dict(workflow_runs=runs)
            else:
                number = int(request.full_url.split('/actions/runs/')[1].split('/')[0])
                data = dict(artifacts=artifacts.get(number, []))
            return io.BytesIO(json.dumps(data).encode())
        output = io.StringIO()
        with patch.dict(os.environ, {'GH_TOKEN': 'synthetic-discovery-fixture'}), \
             patch.object(module.urllib.request, 'urlopen', side_effect=read), \
             patch.object(module.time, 'sleep', side_effect=AssertionError('Unexpected discovery wait')), \
             contextlib.redirect_stdout(output):
            module.find_native_run('YondFane/uTerm', self.head, self.artifact)
        return output.getvalue().strip(), requested

    def available(self):
        return [dict(name=self.artifact, expired=False)]

    def test_manual_same_head_artifacts_are_found(self):
        result, requested = self.discover([self.run_info(12, 'workflow_dispatch')], {12: self.available()})
        self.assertEqual(result, '12')
        self.assertEqual(len(requested), 2)

    def test_pull_request_artifacts_remain_supported(self):
        self.assertEqual(self.discover([self.run_info(9)], {9: self.available()})[0], '9')

    def test_ineligible_event_other_head_or_workflow_is_never_selected(self):
        wrong_head = self.run_info(25); wrong_head['head_sha'] = 'b' * 40
        wrong_workflow = self.run_info(26); wrong_workflow['name'] = 'uTerm'
        runs = [self.run_info(10, 'workflow_dispatch'), self.run_info(24, 'push'), wrong_head, wrong_workflow]
        self.assertEqual(self.discover(runs, {10: self.available()})[0], '10')

    def test_newer_failed_or_expired_evidence_cannot_fall_back_to_an_older_pass(self):
        runs = [self.run_info(9), self.run_info(10, 'workflow_dispatch')]
        for latest in [[], [dict(name=self.artifact, expired=True)]]:
            with self.subTest(latest=latest), self.assertRaisesRegex(AssertionError, 'completed without the required artifact'):
                self.discover(runs, {9: self.available(), 10: latest})


if __name__ == '__main__':
    unittest.main()
