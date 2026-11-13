"""Validate original run-panel scenes. 校验原始运行面板场景。"""

import math


def form_grid_matches(grid, fields, columns, full_interpreter, scale):
    def finite(value):
        return type(value) in [int, float] and math.isfinite(value)
    if not isinstance(grid, dict) or type(columns) is not int or columns not in [2, 3] or type(full_interpreter) is not bool:
        return False
    if not finite(scale) or not 0 < scale <= 8 or not all(finite(grid.get(key)) for key in ['left', 'top', 'width', 'height']) or grid['width'] <= 24 or grid['height'] <= 0:
        return False
    if len(fields) != 3 or not all(all(finite(field.get(key)) for key in ['left', 'top', 'width', 'height']) and field['width'] > 0 and field['height'] > 0 for field in fields):
        return False
    origin, width, gap, epsilon = grid['left'], grid['width'], 12, 0.000001
    column_width = (width - gap * (columns - 1)) / columns
    def rasterized(actual, ideal):
        return math.floor(ideal * scale) / scale - epsilon <= actual <= math.ceil(ideal * scale) / scale + epsilon
    def placed(field, column, full=False):
        left, expected_width = origin + column * (column_width + gap), width if full else column_width
        return (rasterized(field['left'], left) and rasterized(field['width'], expected_width)
                and rasterized(field['left'] + field['width'], left + expected_width)
                and field['left'] + field['width'] <= math.ceil((origin + width) * scale) / scale + epsilon)
    def same_row(left, right):
        return abs(left['top'] - right['top']) < 1 / scale
    first, second, third = fields
    if full_interpreter:
        return columns == 2 and placed(first, 0, True) and placed(second, 0) and placed(third, 1) and same_row(second, third) and second['top'] >= first['top'] + first['height']
    if not (placed(first, 0) and placed(second, 1) and same_row(first, second)):
        return False
    return placed(third, 2) and same_row(first, third) if columns == 3 else placed(third, 0) and third['top'] >= max(first['top'] + first['height'], second['top'] + second['height'])


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
        for key in ['passed', 'actualAdvancedToggle', 'actualTextEditorInput', 'invalidArgumentRetainedWithoutWrite', 'literalArgumentsSaved', 'validArgumentTextRetained', 'temporaryEnvironmentRetainedWithoutPersistence', 'actualSaveButtonAndFeedback', 'compactRightAlignedSave', 'actualConfigurationCollapseAndRestore', 'canonicalStateAndSessionRetained']:
            assert row.get(key) is True, 'Unverified actual run-form action: ' + key
        assert row.get('fixtureArguments') == fixture['runFormInput']['arguments'] and row.get('fixtureEnvironment') == fixture['runFormInput']['environment'] and row.get('savedArguments') == fixture['runFormInput']['argumentValues'], 'Different literal run-form data'
        assert row.get('sourceHeadSHA') == head and row.get('testedMergeSHA') == tested, 'Stale run-form evidence'
        assert all(row.get(key) == report.get(key) for key in ['platform', 'architecture', 'system']), 'Wrong run-form platform'
        name = f"personal-{phase}-run-form-{row['kind']}-{row['language']}-{row['appearance']}-{row['width']}.png"
        assert row.get('screenshot') == name and name in report.get('captures', []), 'Missing actual run-form original'
        assert all(finite(row.get(key)) for key in ['panelWidth', 'saveWidth', 'saveHeight', 'saveRightInset', 'saveVisibleWidth', 'saveVisibleHeight']), 'Missing actual run-form geometry'
        assert 0 < row['panelWidth'] <= row['width'] and 0 < row['saveWidth'] < 200 and abs(row['saveHeight'] - 28) < 1 and 0 <= row['saveRightInset'] <= 40, 'Stretched or misplaced Save configuration'
        assert abs(row['saveVisibleWidth'] - row['saveWidth']) <= 0.5 and abs(row['saveVisibleHeight'] - row['saveHeight']) <= 0.5, 'Clipped Save configuration at capture'
        columns = 2 if row['width'] <= 900 else 3
        full_interpreter = row['kind'] == 'python' and row['width'] <= 850
        assert type(row.get('columnCount')) is int and row['columnCount'] == columns and row.get('interpreterFullRow') is full_interpreter, 'Wrong responsive run-form policy'
        fields = row.get('fieldFrames', [])
        names = ['module', 'mode', 'version'] if row['kind'] == 'java' else ['interpreter', 'mode', 'target']
        assert len(fields) == 3 and [field.get('id') for field in fields] == names, 'Missing actual run-form columns'
        for field in fields:
            assert all(finite(field.get(key)) for key in ['left', 'top', 'width', 'height']) and field['left'] >= 0 and field['width'] > 0 and field['height'] > 0, 'Invalid run-form field'
            assert field['left'] + field['width'] <= row['panelWidth'] + 0.5, 'Overflowing run-form field'
        grid = row.get('formGridFrame')
        assert isinstance(grid, dict) and all(finite(grid.get(key)) for key in ['left', 'top', 'width', 'height']), 'Missing measured form grid'
        assert grid['left'] >= 0 and grid['left'] + grid['width'] <= row['panelWidth'] + 0.5, 'Clipped form grid'
        assert form_grid_matches(grid, fields, columns, full_interpreter, row.get('backingScale')), 'Run fields do not match the measured container and physical pixel bounds'


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
