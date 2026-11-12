"""Synthetic rejection-policy fixtures, never runtime evidence. 合成拒绝策略样例，不能作为运行证据。"""


def policy_scenes(fixture, phase, head, tested, system):
    rows = []
    for item in fixture['runPanelScenes']:
        for kind in fixture['runPanelKinds']:
            for state in fixture['runPanelStates']:
                height = item['height'] - 124 if state == 'expanded' else (380 if kind == 'java' else 470)
                rows.append(dict(item, kind=kind, state=state, passed=True, actualToolbarButton=True,
                                 actualExpandAndRestore=True, retainedPanelView=True, terminalGenerationRetained=True,
                                 canonicalWorkspaceRetained=True, fileVisible=state == 'file',
                                 panelLeft=100, panelTop=item['height']-height, panelWidth=item['width']-200, panelHeight=height, panelHeaderHeight=36,
                                 sourceHeadSHA=head, testedMergeSHA=tested, platform='macOS', architecture='arm64', system=system,
                                 screenshot=f"personal-{phase}-run-{kind}-{state}-{item['language']}-{item['appearance']}-{item['width']}.png"))
    return rows
