"""Find the completed PR test job for the exact tree checked out on a push."""
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote


def github(path):
    response = subprocess.run(
        ["gh", "api", f"repos/{os.environ['GITHUB_REPOSITORY']}/{path}"],
        capture_output=True, text=True, check=True, timeout=20,
    )
    return json.loads(response.stdout)


def passed_pr_run(api, repository, sha, tree, branch, workflow, job_name, test_step):
    matches = [
        pr for pr in api(f"commits/{sha}/pulls")
        if pr["merged_at"] and pr["merge_commit_sha"] == sha
        and pr["base"]["ref"] == branch and pr["head"]["repo"]
        and pr["head"]["repo"]["full_name"] == repository
    ]
    if len(matches) != 1:
        return None
    pr = matches[0]
    head = pr["head"]["sha"]
    runs = api(f"actions/workflows/{quote(workflow, safe='')}/runs?event=pull_request&head_sha={head}&per_page=1")["workflow_runs"]
    if not runs:
        return None
    run = runs[0]
    if (run["status"] != "completed" or run["conclusion"] not in ("success", "failure")
            or run["event"] != "pull_request" or run["head_sha"] != head
            or run["head_repository"]["full_name"] != repository):
        return None
    listing = api(f"actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100")
    if listing["total_count"] != len(listing["jobs"]):
        return None
    suites = [job for job in listing["jobs"] if job["name"] == job_name]
    if len(suites) != 1 or suites[0]["conclusion"] != "success":
        return None
    job = suites[0]
    if not job["completed_at"] or job["completed_at"] > pr["merged_at"]:
        return None
    tests = [step for step in job["steps"] if step["name"] == test_step]
    if len(tests) != 1 or tests[0]["conclusion"] != "success":
        return None
    pattern = rf"Verified PR {pr['number']} checkout ([0-9a-f]{{40}})"
    tested = [m[1] for step in job["steps"] if step["conclusion"] == "success"
              and (m := re.fullmatch(pattern, step["name"]))]
    if len(tested) != 1:
        return None
    commit = api(f"git/commits/{tested[0]}")
    parents = commit["parents"]
    if len(parents) != 2 or parents[1]["sha"] != head or commit["tree"]["sha"] != tree:
        return None
    def timestamp(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    duration = timestamp(tests[0]["completed_at"]) - timestamp(tests[0]["started_at"])
    return dict(schema="plumbline.test-proof.v1", repository=repository, pr=pr["number"],
                workflow=run["path"], run_id=run["id"], attempt=run["run_attempt"],
                job=job_name, job_id=job["id"], url=job["html_url"], test_step=test_step,
                test_seconds=duration.total_seconds(), head=head, tested_commit=tested[0],
                tree=tree, merged_commit=sha)


def main():
    proof = None
    env = os.environ
    if env["GITHUB_EVENT_NAME"] == "push" and env["GITHUB_REF_TYPE"] == "branch":
        try:
            checkout, tree = subprocess.check_output(
                ["git", "rev-parse", "HEAD", "HEAD^{tree}"], text=True).split()
            if checkout == env["GITHUB_SHA"]:
                proof = passed_pr_run(github, env["GITHUB_REPOSITORY"], checkout, tree,
                                      env["GITHUB_REF_NAME"], env["PROOF_WORKFLOW"],
                                      env["PROOF_JOB"], env["PROOF_STEP"])
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
            print(f"PR test evidence unavailable ({type(error).__name__}).")
    with open(env["GITHUB_OUTPUT"], "a") as output:
        if proof:
            directory = Path(tempfile.mkdtemp(dir=env["RUNNER_TEMP"]))
            receipt = directory / "test-proof.json"
            receipt.write_text(json.dumps(proof, indent=2) + "\n")
            print(f"receipt={receipt}", file=output)
        print(f"reuse={'true' if proof else 'false'}", file=output)
    message = (f"Reused [PR test job]({proof['url']}) for Git tree `{proof['tree']}`."
               if proof else "Run the full suite on this checkout.")
    with open(env["GITHUB_STEP_SUMMARY"], "a") as summary:
        print(message, file=summary)


if __name__ == "__main__":
    main()
