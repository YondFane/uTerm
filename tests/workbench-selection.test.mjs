import test from "node:test";
import assert from "node:assert/strict";
import { workbenchSelection } from "../src/lib/workbench-selection.ts";

test("connection selection is consumed once without crossing workspaces or accepting deleted profiles", () => {
  const alpha = { id: "same-id", name: "Alpha" },
    beta = { id: "same-id", name: "Beta" };
  const groups = [
    { id: "a", profiles: [alpha] },
    { id: "b", profiles: [beta] },
  ];
  const request = { request: "click-1", group: "b", id: "same-id" };
  assert.equal(workbenchSelection(request, undefined, "a", groups), null);
  assert.deepEqual(workbenchSelection(request, undefined, "b", groups), {
    request: "click-1",
    group: "b",
    profile: beta,
  });
  assert.equal(workbenchSelection(request, "click-1", "b", groups), null);
  assert.equal(workbenchSelection(request, undefined, "b", [{ id: "b", profiles: [] }]), null);
  assert.equal(workbenchSelection({ ...request, request: "" }, undefined, "b", groups), null);
  assert.equal(workbenchSelection(null, undefined, "b", groups), null);
  assert.equal(
    workbenchSelection({ ...request, request: "click-2" }, "click-1", "b", groups)?.profile,
    beta,
  );
});
