"""Audit source-bound migration evidence without changing issues, branches or release channels.
核对绑定源码的改造证据，不修改 Issue、分支或发布渠道。
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from zipfile import ZipFile

REPOSITORY = "YondFane/uTerm"
WORKFLOWS = {
    "Native migration": 2,
    "uTerm": 2,
    "Client performance evidence": 3,
    "Windows signed updater QA": 1,
    "Candidate Windows QA": 1,
    "Client upgrade and rollback": 2,
}


def gh(*arguments):
    return json.loads(subprocess.check_output(["gh", *arguments], text=True, encoding="utf-8"))


def inspect_evidence(archive, head):
    reports, images, errors, merges = [], [], [], set()
    with ZipFile(archive) as bundle:
        for item in bundle.infolist():
            if item.filename.endswith(".png"):
                with bundle.open(item) as stream:
                    signature = stream.read(8)
                    if signature != b"\x89PNG\r\n\x1a\n":
                        errors.append("Invalid PNG signature: " + item.filename)
                images.append(item.filename)
            if not item.filename.endswith(".json") or item.file_size > 8 * 1024 * 1024:
                continue
            raw = bundle.read(item)
            value = json.loads(raw)
            if not isinstance(value, dict):
                continue
            source = value.get("sourceHeadSHA", value.get("head"))
            tested = value.get("testedMergeSHA", value.get("tested", value.get("sourceSHA")))
            if not source or not tested or "passed" not in value:
                continue
            identity = item.filename
            if source != head:
                errors.append("Stale report source: " + identity)
            if not isinstance(tested, str) or not re.fullmatch(r"[0-9a-f]{40}", tested):
                errors.append("Missing exact tested merge: " + identity)
            else:
                merges.add(tested)
            if value.get("sourceTreeDirty") is not False or value.get("productionDataAccess", False) is not False:
                errors.append("Unclean source or production access: " + identity)
            if value["passed"] is not True or value.get("cleanupErrors") or value.get("failure"):
                errors.append("Failed report: " + identity)
            for acceptance in ["stableCutoverAccepted", "performanceAcceptanceComplete", "actualInstallationAccepted"]:
                if value.get(acceptance) is False:
                    errors.append("Acceptance remains incomplete: " + identity + ":" + acceptance)
            reports.append(dict(file=identity, sha256=hashlib.sha256(raw).hexdigest(),
                                sourceHeadSHA=source, testedMergeSHA=tested, passed=value["passed"]))
    if not reports:
        errors.append("Artifact contains no source-bound acceptance report")
    return dict(reports=reports, screenshots=images, errors=errors, testedMergeSHAs=sorted(merges))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--head", required=True)
    parser.add_argument("--output", default="ci-evidence/readiness")
    args = parser.parse_args()
    assert re.fullmatch(r"[0-9a-f]{40}", args.head)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    blockers, artifacts, merges = [], [], set()
    issues = gh("issue", "list", "--repo", REPOSITORY, "--state", "all", "--limit", "100",
                "--json", "number,title,state,url,assignees")
    tasks = {item["number"]: item for item in issues if 20 <= item["number"] <= 47}
    for number in range(20, 47):
        if tasks.get(number, {}).get("state") != "CLOSED":
            blockers.append(f"Task #{number} remains open or unavailable")
    pr = gh("pr", "view", "12", "--repo", REPOSITORY, "--json",
            "url,state,isDraft,baseRefName,headRefName,headRefOid,mergedAt")
    if not (pr["isDraft"] and pr["state"] == "OPEN" and pr["baseRefName"] == "release"
            and pr["headRefName"] == "feat/native-macos-shared-core" and pr["headRefOid"] == args.head
            and pr["mergedAt"] is None):
        blockers.append("PR identity/head/draft/unmerged boundary differs from this task")
    refs = {branch: gh("api", f"repos/{REPOSITORY}/git/ref/heads/{branch}")["object"]["sha"]
            for branch in ["release", "main"]}
    runs = gh("run", "list", "--repo", REPOSITORY, "--commit", args.head, "--limit", "100",
              "--json", "databaseId,workflowName,headSha,status,conclusion,url")
    selected = []
    with tempfile.TemporaryDirectory(prefix="uterm-readiness-evidence-") as directory:
        for name, count in WORKFLOWS.items():
            run = next((item for item in runs if item["workflowName"] == name), None)
            if run is None:
                blockers.append("No current-source workflow: " + name)
                continue
            selected.append(run)
            jobs = gh("api", f"repos/{REPOSITORY}/actions/runs/{run['databaseId']}/jobs?per_page=100")["jobs"]
            if run["headSha"] != args.head or run["conclusion"] != "success" or len(jobs) != count or any(
                job["conclusion"] != "success" for job in jobs
            ):
                blockers.append("Incomplete or failed workflow: " + name)
            inventory = gh("api", f"repos/{REPOSITORY}/actions/runs/{run['databaseId']}/artifacts?per_page=100")["artifacts"]
            if len(inventory) < count:
                blockers.append("Missing platform artifacts: " + name)
            for item in inventory:
                record = dict(name=item["name"], id=item["id"], workflow=run["url"],
                              url=f"{run['url']}/artifacts/{item['id']}")
                try:
                    assert not item["expired"] and item["name"].endswith(args.head), "Stale/expired artifact"
                    archive = Path(directory) / (str(item["id"]) + ".zip")
                    with archive.open("wb") as stream:
                        subprocess.run(["gh", "api", f"repos/{REPOSITORY}/actions/artifacts/{item['id']}/zip"],
                                       stdout=stream, check=True, timeout=300)
                    record.update(inspect_evidence(archive, args.head))
                    merges.update(record["testedMergeSHAs"])
                    blockers.extend(item["name"] + ": " + error for error in record["errors"])
                    archive.unlink()
                except Exception as error:
                    blockers.append(item["name"] + ": " + str(error))
                artifacts.append(record)
    if len(merges) != 1:
        blockers.append("Current-source evidence does not identify one common tested merge")
    report = dict(sourceHeadSHA=args.head, testedMergeSHAs=sorted(merges), pullRequest=pr,
                  protectedRefsObserved=refs, tasks=list(tasks.values()), workflows=selected,
                  artifacts=artifacts, blockers=blockers, releaseReady=not blockers,
                  manualAcceptance="waived by user; simulations remain labelled in underlying reports",
                  limits=["Report inventory does not replace original-window inspection or task acceptance",
                          "Original M3 layout/PDF/run-panel gaps remain in #13/#17; no stable cutover is declared",
                          "Signing/notarization conditions remain in candidate reports; no production credentials are inferred"],
                  mergeOrPublishPerformed=False, productionFeedChanged=False)
    (output / "migration-readiness.json").write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(dict(releaseReady=not blockers, blockers=blockers), ensure_ascii=False))
    return 0 if not blockers else 1


if __name__ == "__main__":
    raise SystemExit(main())
