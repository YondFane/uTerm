"""Validate original run-panel scenes. 校验原始运行面板场景。"""

import math


def validate_native_run_forms(report, fixture, head, tested, phase):
    expected = {(kind, row['language'], row['appearance'], row['width'], row['height'])
                for kind in fixture['runPanelKinds'] for row in fixture['runPanelScenes']}
    proofs = report.get('runPanelFormProof', [])
    def identity(row):
        return tuple(row.get(key) for key in ['kind', 'language', 'appearance', 'width', 'height'])
    assert len(proofs) == len(expected) and {identity(row) for row in proofs} == expected, 'Missing or duplicate actual run-form evidence'
    def finite(value):
        return type(value) in [int, float] and math.isfinite(value)
    for row in proofs:
        for key in ['passed', 'actualAdvancedToggle', 'actualSaveButtonAndFeedback', 'compactRightAlignedSave', 'actualConfigurationCollapseAndRestore', 'canonicalStateAndSessionRetained']:
            assert row.get(key) is True, 'Unverified actual run-form action: ' + key
        assert row.get('sourceHeadSHA') == head and row.get('testedMergeSHA') == tested, 'Stale run-form evidence'
        assert all(row.get(key) == report.get(key) for key in ['platform', 'architecture', 'system']), 'Wrong run-form platform'
        name = f"personal-{phase}-run-form-{row['kind']}-{row['language']}-{row['appearance']}-{row['width']}.png"
        assert row.get('screenshot') == name and name in report.get('captures', []), 'Missing actual run-form original'
        assert all(finite(row.get(key)) for key in ['panelWidth', 'saveWidth', 'saveHeight', 'saveRightInset']), 'Missing actual run-form geometry'
        assert 0 < row['panelWidth'] <= row['width'] and 0 < row['saveWidth'] < 200 and abs(row['saveHeight'] - 28) < 1 and 0 <= row['saveRightInset'] <= 40, 'Stretched or misplaced Save configuration'
        columns = 2 if row['width'] <= 900 else 3
        full_interpreter = row['kind'] == 'python' and row['width'] <= 850
        assert type(row.get('columnCount')) is int and row['columnCount'] == columns and row.get('interpreterFullRow') is full_interpreter, 'Wrong responsive run-form policy'
        fields = row.get('fieldFrames', [])
        names = ['module', 'mode', 'version'] if row['kind'] == 'java' else ['interpreter', 'mode', 'target']
        assert len(fields) == 3 and [field.get('id') for field in fields] == names, 'Missing actual run-form columns'
        for field in fields:
            assert all(finite(field.get(key)) for key in ['left', 'top', 'width', 'height']) and field['left'] >= 0 and field['width'] > 0 and field['height'] > 0, 'Invalid run-form field'
            assert field['left'] + field['width'] <= row['panelWidth'] + 0.5, 'Overflowing run-form field'
        first, second, third = fields
        def same(left, right, key):
            return abs(left[key] - right[key]) < 1
        if full_interpreter:
            assert abs(first['width'] - (second['width'] * 2 + 12)) < 1 and same(second, third, 'width'), 'Interpreter must fill the narrow row'
            assert same(first, second, 'left') and third['left'] >= second['left'] + second['width'], 'Misplaced narrow Python fields'
            assert same(second, third, 'top') and second['top'] >= first['top'] + first['height'], 'Overlapping interpreter row'
        else:
            assert all(same(field, first, 'width') for field in fields) and second['left'] >= first['left'] + first['width'] and same(first, second, 'top'), 'Misplaced equal-width run fields'
            if columns == 3:
                assert third['left'] >= second['left'] + second['width'] and same(third, first, 'top'), 'Misplaced wide third column'
            else:
                assert same(third, first, 'left') and third['top'] >= max(first['top'] + first['height'], second['top'] + second['height']), 'Misplaced wrapped run field'


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
        for key in ['panelLeft', 'panelTop', 'panelWidth', 'panelHeight', 'panelHeaderHeight']:
            value = row.get(key)
            assert type(value) in [int, float] and math.isfinite(value) and value >= 0, 'Missing actual run-panel geometry: ' + key
        assert row['panelWidth'] > 0 and row['panelHeight'] > 0 and 0 < row['panelHeaderHeight'] <= row['panelHeight']
        assert row['panelLeft'] + row['panelWidth'] <= row['width'] + 0.5 and row['panelTop'] + row['panelHeight'] <= row['height'] + 0.5, 'Run panel extends outside its actual window'
    return {identity(row): row for row in scenes}
