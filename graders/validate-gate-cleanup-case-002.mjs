#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const workspace = process.env.EVALUATE_WORKSPACE;
if (!workspace) {
  throw new Error("EVALUATE_WORKSPACE is not set.");
}

const files = {
  items: "documentmru/aggregatedmru/AggItems.cpp",
  factory:
    "documentmru/aggregatedmru/AggItemUpdateRequestFactory.cpp",
  gatesCpp: "documentmru/aggregatedmru/Gates.cpp",
  gatesH: "documentmru/aggregatedmru/Gates.h",
};

const content = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, relativePath]) => [
      key,
      await readFile(path.join(workspace, relativePath), "utf8"),
    ]),
  ),
);

const checks = [
  {
    name: "call-sites-removed",
    passed:
      !content.items.includes("IsOptimisticUIUpdateEnabled") &&
      !content.factory.includes("IsOptimisticUIUpdateEnabled"),
    evidence:
      "Touched call-site files contain no IsOptimisticUIUpdateEnabled references.",
  },
  {
    name: "gate-definition-removed",
    passed:
      !content.gatesCpp.includes("IsOptimisticUIUpdateEnabled") &&
      !content.gatesH.includes("IsOptimisticUIUpdateEnabled"),
    evidence:
      "Gates.cpp and Gates.h contain no IsOptimisticUIUpdateEnabled definition or declaration.",
  },
  {
    name: "lock-scope-preserved",
    passed:
      /\{\s*const\s+(?:std::scoped_lock|Mso::CritSec_Locker)\s+locker\s*\{[^}]+\};\s*wrappedItems\s*=\s*m_pendingChanges\.ApplyOptimisticChanges\([^;]+;\s*\}/s.test(
        content.items,
      ),
    evidence:
      "GetSnapshot keeps the locker and ApplyOptimisticChanges inside an explicit scope block.",
  },
  {
    name: "unrelated-gates-preserved",
    passed:
      content.gatesCpp.includes("GetResumeSyncTimeoutMs") &&
      content.gatesCpp.includes("GetIdentitiesFromActiveProfile") &&
      content.gatesH.includes("GetResumeSyncTimeoutMs") &&
      content.gatesH.includes("GetIdentitiesFromActiveProfile"),
    evidence:
      "Unrelated Aggregated MRU gate APIs remain present.",
  },
];

const passed = checks.every((check) => check.passed);
process.stdout.write(
  JSON.stringify({
    name: "gate-cleanup-case-002",
    kind: "code",
    passed,
    score:
      checks.filter((check) => check.passed).length / checks.length,
    label: passed ? "correct" : "incorrect",
    evidence: `${checks.filter((check) => check.passed).length}/${checks.length} case-002 assertions passed`,
    details: checks.map((check) => ({
      ...check,
      kind: "code",
      score: check.passed ? 1 : 0,
      label: check.passed ? "correct" : "incorrect",
    })),
  }),
);
