"""Synthetic rejection-policy fixtures, never runtime evidence. 合成拒绝策略样例，不能作为运行证据。"""


def policy_scenes(fixture, phase, head, tested, system):
    rows = []
    for item in fixture['runPanelScenes']:
        for kind in fixture['runPanelKinds']:
            for state in fixture['runPanelStates']:
                height = item['height'] - 80 if state == 'expanded' else (380 if kind == 'java' else 470)
                rows.append(dict(item, kind=kind, state=state, passed=True, actualToolbarButton=True,
                                 actualExpandAndRestore=True, retainedPanelView=True, terminalGenerationRetained=True,
                                 canonicalWorkspaceRetained=True, fileVisible=state == 'file',
                                 panelLeft=100, panelTop=item['height']-height, panelWidth=item['width']-200, panelHeight=height, panelHeaderHeight=46,
                                 sourceHeadSHA=head, testedMergeSHA=tested, platform='macOS', architecture='arm64', system=system,
                                 screenshot=f"personal-{phase}-run-{kind}-{state}-{item['language']}-{item['appearance']}-{item['width']}.png"))
    return rows


def policy_forms(fixture, phase, head, tested, system):
    rows = []
    for item in fixture['runPanelScenes']:
        for kind in fixture['runPanelKinds']:
            names = ['module', 'mode', 'version'] if kind == 'java' else ['interpreter', 'mode', 'target']
            columns = 2 if item['width'] <= 900 else 3
            full_interpreter = kind == 'python' and item['width'] <= 850
            fields = [dict(id=name, left=12 + index*96, top=20, width=84, height=40) for index, name in enumerate(names)]
            if columns == 2:
                fields = [dict(id=name, left=12 + (index % 2)*144, top=20 + (index // 2)*48, width=132, height=40) for index, name in enumerate(names)]
            if full_interpreter:
                fields = [dict(id=names[0], left=12, top=20, width=276, height=60), dict(id=names[1], left=12, top=88, width=132, height=40), dict(id=names[2], left=156, top=88, width=132, height=40)]
            rows.append(dict(item, kind=kind, passed=True, actualAdvancedToggle=True, actualTextEditorInput=True, invalidArgumentRetainedWithoutWrite=True, literalArgumentsSaved=True, temporaryEnvironmentRetainedWithoutPersistence=True,
                             fixtureArguments=fixture["runFormInput"]["arguments"], fixtureEnvironment=fixture["runFormInput"]["environment"], savedArguments=fixture["runFormInput"]["argumentValues"], actualSaveButtonAndFeedback=True,
                             compactRightAlignedSave=True, actualConfigurationCollapseAndRestore=True,
                             canonicalStateAndSessionRetained=True, panelWidth=300, saveWidth=100, saveHeight=28, saveRightInset=12,
                             fieldFrames=fields, columnCount=columns, interpreterFullRow=full_interpreter,
                             sourceHeadSHA=head, testedMergeSHA=tested, platform='macOS', architecture='arm64', system=system,
                             screenshot=f"personal-{phase}-run-form-{kind}-{item['language']}-{item['appearance']}-{item['width']}.png"))
    return rows
