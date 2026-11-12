"""Validate actual PR modal evidence. 校验实际 PR 模态证据。"""

import math


def validate_pr(scene, fixture):
    assert scene.get("form") == fixture["github"], "Different PR fixture data"
    for proof in ["actualToolsSwitcher", "literalInputRetained", "readableFields", "workspaceVisibleAroundDialog", "terminalGenerationRetained", "savedWorkspaceUnchanged", "isolatedSimulatedCLI", "noGitHubWrites", "actualCancelPreservedState"]:
        assert scene.get(proof) is True, "Unverified PR operation: " + proof
    for key in ["modalLeft", "modalTop", "modalWidth", "modalHeight"]:
        assert type(scene.get(key)) in [int, float] and math.isfinite(scene[key]), "Missing actual PR geometry: " + key
    width, height = scene["width"], scene["height"]
    assert abs(scene["modalWidth"] - min(640, width * .92)) < 1, "PR form is limited to a tools viewport"
    assert 40 <= scene["modalHeight"] <= height - 48, "PR form is clipped"
    assert abs(scene["modalLeft"] - (width - scene["modalWidth"]) / 2) < 1 and abs(scene["modalTop"] - (height - scene["modalHeight"]) / 2) < 1, "PR form is not centered"
