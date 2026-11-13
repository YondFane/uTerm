"""Reject clipped or incomplete native workbench evidence. 拒绝裁切或不完整的原生工作台证据。"""
import math


def validate_workbench_layout(report, head, tested):
    scenes = {('en', 'dark', 1100), ('zh-Hans', 'light', 640)}
    def key(row):
        return row.get('language'), row.get('appearance'), row.get('width')
    def numeric(value):
        return type(value) in [int, float] and math.isfinite(value)
    def identity(row):
        assert row.get('sourceHeadSHA') == head and row.get('testedMergeSHA') == tested, 'Stale workbench layout evidence'
        assert all(row.get(name) == report.get(name) for name in ['platform', 'architecture', 'system']), 'Wrong workbench platform'
        assert report.get('platform') == 'macOS' and report.get('architecture') in ['arm64', 'x86_64'] and report.get('system'), 'Missing native platform'
        assert key(row) in scenes and row.get('height') == 720, 'Wrong workbench scene'
        assert row.get('passed') is True and numeric(row.get('viewportWidth')) and row['viewportWidth'] > 0, 'Invalid actual workbench viewport'
    ssh = report.get('sshWorkspaceLayoutProof', [])
    assert len(ssh) == 2 and {key(row) for row in ssh} == scenes, 'Missing or duplicate SSH layout scenes'
    for row in ssh:
        identity(row)
        assert row.get('draftAndSavedDataRetained') is True, 'SSH draft or saved data changed'
        narrow = row['viewportWidth'] < 720
        assert row.get('narrow') is narrow and row.get('actualConnectionsToggle') is narrow, 'Narrow SSH disclosure was not operated'
        frames = row.get('fieldFrames', [])
        assert len(frames) == 2 and {f.get('id') for f in frames} == {'native-ssh-profile-fields-frame', 'native-ssh-save-frame'}, 'Missing actual SSH controls'
        for frame in frames:
            assert all(numeric(frame.get(name)) for name in ['left', 'width', 'height']), 'Invalid SSH geometry'
            assert frame['left'] >= 0 and frame['width'] > 0 and frame['height'] > 0 and frame['left'] + frame['width'] <= row['viewportWidth'] + .5, 'Clipped SSH controls'
    connections = report.get('connectionWorkspaceLayoutProof', [])
    expected = {(kind, *scene) for kind in ['database', 'redis'] for scene in scenes}
    assert len(connections) == 4 and {(row.get('kind'), *key(row)) for row in connections} == expected, 'Missing or duplicate connection layout scenes'
    files = set()
    for row in connections:
        identity(row)
        for name in ['actualConnectionsButton', 'actualReturnButton', 'actualProfileSelection', 'sameWorkbenchDOMAndProfile', 'savedDataRetained', 'fullWidthWorkbench', 'profileModeFitsViewport']:
            assert row.get(name) is True, 'Unverified workbench action: ' + name
        assert numeric(row.get('connectionsWidth')) and 0 < row['connectionsWidth'] <= row['viewportWidth'] + .5, 'Connection list clips outside the viewport'
        if row['viewportWidth'] < 720:
            assert abs(row['connectionsWidth'] - row['viewportWidth']) < 1, 'Narrow connection mode must use the full viewport'
        filename = f"native-workspace-panel-{row['kind']}-connections-{row['language']}-{row['appearance']}-{row['width']}.png"
        assert row.get('screenshot') == filename and filename in report.get('captures', []), 'Missing connection-mode original'
        files.add(filename)
    return files
