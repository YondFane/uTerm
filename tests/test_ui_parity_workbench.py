"""Synthetic rejection tests, not native acceptance. 合成拒绝策略测试，不代表原生验收。"""
import copy
import unittest
from scripts.ui_parity_workbench import validate_workbench_layout


class WorkbenchLayoutPolicyTests(unittest.TestCase):
    def setUp(self):
        self.report = dict(platform='macOS', architecture='arm64', system='policy fixture', captures=[], sshWorkspaceLayoutProof=[], connectionWorkspaceLayoutProof=[])
        for language, appearance, width, viewport in [('en', 'dark', 1100, 850), ('zh-Hans', 'light', 640, 448)]:
            base = dict(language=language, appearance=appearance, width=width, height=720, viewportWidth=viewport, sourceHeadSHA='a'*40, testedMergeSHA='b'*40, passed=True, platform='macOS', architecture='arm64', system='policy fixture')
            self.report['sshWorkspaceLayoutProof'].append(dict(base, kind='ssh', narrow=viewport<720, actualConnectionsToggle=viewport<720, draftAndSavedDataRetained=True, fieldFrames=[dict(id=name, left=12, width=200, height=28) for name in ['native-ssh-profile-fields-frame', 'native-ssh-save-frame']]))
            for kind in ['database', 'redis']:
                filename=f'native-workspace-panel-{kind}-connections-{language}-{appearance}-{width}.png'
                self.report['connectionWorkspaceLayoutProof'].append(dict(base, kind=kind, actualConnectionsButton=True, actualReturnButton=True, actualProfileSelection=True, sameWorkbenchDOMAndProfile=True, savedDataRetained=True, fullWidthWorkbench=True, profileModeFitsViewport=True, connectionsWidth=viewport if viewport<720 else 220, screenshot=filename))
                self.report['captures'].append(filename)
    def check(self, report):
        return validate_workbench_layout(report, 'a'*40, 'b'*40)
    def test_complete_native_controls_require_four_originals(self):
        self.assertEqual(len(self.check(self.report)), 4)
    def test_ssh_rejects_the_observed_clipping_and_unexecuted_disclosure(self):
        for key, value in [('narrow', False), ('actualConnectionsToggle', False), ('draftAndSavedDataRetained', False), ('sourceHeadSHA', 'c'*40), ('viewportWidth', float('nan')), ('fieldFrames', [dict(id=name, left=150, width=550, height=28) for name in ['native-ssh-profile-fields-frame', 'native-ssh-save-frame']])]:
            bad=copy.deepcopy(self.report);bad['sshWorkspaceLayoutProof'][1][key]=value
            with self.subTest(key=key), self.assertRaises(AssertionError):self.check(bad)
    def test_connections_reject_hidden_actions_wrong_platform_and_squeezed_columns(self):
        changes=[(key,False) for key in ['actualConnectionsButton','actualReturnButton','actualProfileSelection','sameWorkbenchDOMAndProfile','savedDataRetained','fullWidthWorkbench','profileModeFitsViewport']]
        changes += [('connectionsWidth',220),('viewportWidth',True),('connectionsWidth',float('inf')),('testedMergeSHA','c'*40),('architecture','x86_64'),('screenshot','old.png')]
        for key,value in changes:
            bad=copy.deepcopy(self.report);bad['connectionWorkspaceLayoutProof'][2][key]=value
            with self.subTest(key=key),self.assertRaises(AssertionError):self.check(bad)
    def test_missing_duplicate_or_unreferenced_originals_never_pass(self):
        for field in ['sshWorkspaceLayoutProof','connectionWorkspaceLayoutProof','captures']:
            bad=copy.deepcopy(self.report);bad[field]=bad[field][:-1]
            with self.subTest(field=field),self.assertRaises(AssertionError):self.check(bad)
        bad=copy.deepcopy(self.report);bad['connectionWorkspaceLayoutProof'][0]=copy.deepcopy(bad['connectionWorkspaceLayoutProof'][1])
        with self.assertRaises(AssertionError):self.check(bad)
