import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveExperiment } from "@microsoft/vally";

const EXPECTED_WORKSPACE = "/Volumes/Office/Office2/src";

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function officeHead() {
  const script = [
    "set -e",
    'cd "$TARGET_WORKSPACE"',
    'source "$TARGET_WORKSPACE/init.sh" >/dev/null',
    "PATH=/usr/local/bin:$PATH",
    "GIT_EXEC_PATH=/usr/local/git/libexec/git-core",
    "export PATH GIT_EXEC_PATH",
    'git rev-parse HEAD',
  ].join("\n");
  return execFileSync("/bin/bash", ["-lc", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      TARGET_WORKSPACE: EXPECTED_WORKSPACE,
      TERM: "dumb",
    },
  }).trim();
}

function runCommand(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} exited with code ${result.status ?? "unknown"}`,
    );
  }
  return result.stdout;
}

async function main() {
  if (!process.env.COPILOT_GITHUB_TOKEN) {
    throw new Error(
      "COPILOT_GITHUB_TOKEN is required (fine-grained PAT with Copilot Requests permission).",
    );
  }

  const experimentPath = path.resolve(
    process.argv[2] ??
      "experiments/omr-model-comparison.experiment.yaml",
  );
  const resolved = await resolveExperiment(experimentPath);
  if (resolved.plans.length !== 3) {
    throw new Error(
      `Expected exactly three model variants; resolved ${resolved.plans.length}.`,
    );
  }
  if (resolved.plans.some((plan) => !plan.effectiveSpec.defaults?.model)) {
    throw new Error("Every live-workspace variant must specify a model.");
  }
  if (resolved.plans.some((plan) => plan.originalEvalSpec.stimuli?.length !== 1)) {
    throw new Error(
      "The live-workspace experiment currently supports one stimulus per eval.",
    );
  }

  const runRoot = path.resolve(
    "vally-results",
    "omr-live-model-comparison",
    timestamp(),
  );
  await mkdir(path.join(runRoot, "comparisons"), { recursive: true });
  const initialHead = officeHead();
  const variants = [];

  for (const plan of resolved.plans) {
    const model = plan.effectiveSpec.defaults.model;
    const variantDir = path.join(runRoot, plan.variant);
    console.log(`\n=== ${plan.variant} (${model}) ===\n`);
    runCommand(
      process.execPath,
      [
        path.resolve("scripts/run-live-workspace-eval.mjs"),
        plan.evalFile,
      ],
      {
        ...process.env,
        OMR_EVAL_MODEL: model,
        OMR_EVAL_VARIANT: plan.variant,
        OMR_EVAL_OUTPUT_DIR: variantDir,
      },
    );
    variants.push({
      name: plan.variant,
      model,
      outputDir: variantDir,
      configHash: plan.configHash,
      evalHash: plan.evalHash,
    });
  }

  const finalHead = officeHead();
  if (finalHead !== initialHead) {
    throw new Error(
      `Office2 HEAD changed during the experiment (${initialHead} -> ${finalHead}).`,
    );
  }

  const baseline = variants.find(
    (variant) => variant.name === resolved.baseline,
  );
  if (!baseline) {
    throw new Error(`Baseline variant ${resolved.baseline} was not executed.`);
  }

  const comparisons = [];
  for (const treatment of variants.filter(
    (variant) => variant.name !== baseline.name,
  )) {
    console.log(`\n=== Compare ${treatment.model} vs ${baseline.model} ===\n`);
    const output = runCommand(
      process.execPath,
      [
        path.resolve("node_modules/@microsoft/vally-cli/dist/index.js"),
        "compare",
        "--baseline",
        baseline.outputDir,
        "--treatment",
        treatment.outputDir,
        "--judge-model",
        "gpt-5.6-sol",
        "--verbose",
      ],
      process.env,
    );
    const comparisonPath = path.join(
      runRoot,
      "comparisons",
      `${treatment.model}-vs-${baseline.model}.txt`,
    );
    await writeFile(comparisonPath, output);
    comparisons.push({
      baseline: baseline.model,
      treatment: treatment.model,
      path: comparisonPath,
    });
  }

  const manifest = {
    experiment: resolved.name,
    experimentFile: resolved.experimentFile,
    baseline: resolved.baseline,
    vary: resolved.vary,
    officeWorkspace: EXPECTED_WORKSPACE,
    officeHead: initialHead,
    variants,
    comparisons,
  };
  await writeFile(
    path.join(runRoot, "live-experiment-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`\nExperiment results: ${runRoot}`);
}

await main();
