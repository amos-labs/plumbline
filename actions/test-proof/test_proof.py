import copy
import unittest

from proof import passed_pr_run


class EvidenceTest(unittest.TestCase):
    head, checkout, merge, tree = (c * 40 for c in "1234")
    repo = "example/project"

    def setUp(self):
        self.pr = dict(number=7, base={"ref": "main"}, head={"sha": self.head, "repo": {"full_name": self.repo}},
                       merge_commit_sha=self.merge, merged_at="2026-01-14T12:00:00Z")
        self.run = dict(id=15, run_attempt=2, path=".github/workflows/ci.yml", head_sha=self.head,
                        head_repository={"full_name": self.repo}, event="pull_request", status="completed", conclusion="failure")
        self.test = dict(name="Full suite", conclusion="success", started_at="2026-01-14T11:40:00Z",
                         completed_at="2026-01-14T11:45:00Z")
        self.marker = dict(name=f"Verified PR 7 checkout {self.checkout}", conclusion="success")
        self.job = dict(id=99, name="tests", conclusion="success", completed_at="2026-01-14T11:50:00Z",
                        html_url="https://example.com/job", steps=[self.test, self.marker])
        self.commit = dict(parents=[{"sha": "base"}, {"sha": self.head}], tree={"sha": self.tree})
        self.jobs = {"jobs": [self.job], "total_count": 1}
        self.api = {
            f"commits/{self.merge}/pulls": [self.pr],
            f"actions/workflows/ci.yml/runs?event=pull_request&head_sha={self.head}&per_page=1": {"workflow_runs": [self.run]},
            "actions/runs/15/attempts/2/jobs?per_page=100": self.jobs,
            f"git/commits/{self.checkout}": self.commit,
        }

    def prove(self):
        return passed_pr_run(self.api.__getitem__, self.repo, self.merge, self.tree, "main", "ci.yml", "tests", "Full suite")

    def test_provenance_from_succeeded_job_despite_separate_governance_failure(self):
        receipt = self.prove()
        self.assertEqual(receipt["tested_commit"], self.checkout)
        self.assertEqual(receipt["attempt"], 2)
        self.assertEqual(receipt["job_id"], 99)
        self.assertEqual(receipt["test_seconds"], 300)

    def test_fallback(self):
        for obj, key, value in [
            (self.pr["base"], "ref", "other"), (self.pr["head"]["repo"], "full_name", "fork/project"),
            (self.run, "status", "in_progress"), (self.run, "event", "push"), (self.run, "head_sha", self.merge),
            (self.job, "conclusion", "failure"), (self.job, "completed_at", "2026-01-14T12:01:00Z"),
            (self.jobs, "total_count", 101), (self.job, "steps", [self.test, self.test, self.marker]),
            (self.test, "conclusion", "skipped"), (self.marker, "conclusion", "skipped"),
            (self.marker, "name", f"Verified PR 8 checkout {self.checkout}"),
            (self.commit["tree"], "sha", self.merge), (self.commit, "parents", [{"sha": self.head}]),
        ]:
            with self.subTest(key=key, value=value):
                old = obj[key]
                obj[key] = copy.deepcopy(value)
                try:
                    self.assertIsNone(self.prove())
                finally:
                    obj[key] = old
