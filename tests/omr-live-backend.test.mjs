import assert from "node:assert/strict";
import test from "node:test";
import {
  addFixtureScopeGuard,
  addWorkspaceGuard,
} from "../backends/omr-live-backend.mjs";

test("workspace guard preserves a passing grade when unchanged", () => {
  const result = addWorkspaceGuard(
    {
      name: "trajectory-grade",
      kind: "code",
      passed: true,
      score: 1,
      evidence: "1/1 graders passed",
      details: [
        {
          name: "completed",
          kind: "code",
          passed: true,
          score: 1,
          evidence: "complete",
        },
      ],
    },
    true,
  );

  assert.equal(result.passed, true);
  assert.equal(result.score, 1);
  assert.equal(result.details.at(-1).name, "workspace-unchanged");
});

test("workspace guard fails the grade when the checkout changes", () => {
  const result = addWorkspaceGuard(
    {
      name: "trajectory-grade",
      kind: "code",
      passed: true,
      score: 1,
      evidence: "1/1 graders passed",
      details: [
        {
          name: "completed",
          kind: "code",
          passed: true,
          score: 1,
          evidence: "complete",
        },
      ],
    },
    false,
  );

  assert.equal(result.passed, false);
  assert.equal(result.score, 0.5);
  assert.equal(result.details.at(-1).passed, false);
});

test("fixture scope guard rejects files outside the case", () => {
  const result = addFixtureScopeGuard(
    {
      name: "trajectory-grade",
      kind: "code",
      passed: true,
      score: 1,
      evidence: "passed",
      details: [],
    },
    false,
    ["documentmru/aggregatedmru/AggItems.cpp", "unrelated.txt"],
  );

  assert.equal(result.passed, false);
  assert.match(result.details.at(-1).evidence, /unrelated\.txt/);
});
