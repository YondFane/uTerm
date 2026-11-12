"""Validate original run-panel scenes. 校验原始运行面板场景。"""

import math


def validate_run_panels(scenes, fixture):
    expected = {(kind, state, item['language'], item['appearance'], item['width'], item['height'])
                for kind in fixture['runPanelKinds'] for state in fixture['runPanelStates'] for item in fixture['runPanelScenes']}
    def identity(row):
        return tuple(row.get(key) for key in ['kind', 'state', 'language', 'appearance', 'width', 'height'])
    assert len(scenes) == len(expected) and {identity(row) for row in scenes} == expected, 'Missing, duplicate or unexpected run-panel scenes'
    for row in scenes:
        for key in ['passed', 'actualToolbarButton', 'actualExpandAndRestore', 'retainedPanelView', 'terminalGenerationRetained', 'canonicalWorkspaceRetained']:
            assert row.get(key) is True, 'Unverified run-panel operation: ' + key
        assert type(row.get('fileVisible')) is bool and row['fileVisible'] == (row['state'] == 'file'), 'Run-panel file coexistence was not executed'
        for key in ['panelLeft', 'panelTop', 'panelWidth', 'panelHeight']:
            value = row.get(key)
            assert type(value) in [int, float] and math.isfinite(value) and value >= 0, 'Missing actual run-panel geometry: ' + key
        assert row['panelWidth'] > 0 and row['panelHeight'] > 0
        assert row['panelLeft'] + row['panelWidth'] <= row['width'] + 0.5 and row['panelTop'] + row['panelHeight'] <= row['height'] + 0.5, 'Run panel extends outside its actual window'
    return {identity(row): row for row in scenes}
