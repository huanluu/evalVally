import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import {
  CompositeEvalReporter,
  createExecutorRegistry,
  createDefaultGraderRegistry,
  EvalJsonlReporter,
  EvalJunitReporter,
  EvalMarkdownReporter,
  gradeTrajectory,
  loadEvalSpec,
  parseDuration,
  parseSkill,
  planRun,
  ProjectContext,
  runEval,
} from "@microsoft/vally";
import { CopilotSdkExecutor } from "@microsoft/vally/executor";

const EXPECTED_WORKSPACE = "/Volumes/Office/Office2/src";
const TARGET_FILE = "documentmru/aggregatedmru/AddRecentItemRequests.cpp";
const OMR_BUILD_SKILL =
  "harness/utilities/.claude/skills/omr-build/SKILL.md";
const LOCK_PATH = "/tmp/vally-office2-live-workspace.lock";

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function officeGitStatus(workspace) {
  const script = [
    "set -e",
    'cd "$TARGET_WORKSPACE"',
    'source "$TARGET_WORKSPACE/init.sh" >/dev/null',
    "PATH=/usr/local/bin:$PATH",
    "GIT_EXEC_PATH=/usr/local/git/libexec/git-core",
    "export PATH GIT_EXEC_PATH",
    'git --no-pager status --porcelain=v1 --untracked-files=all',
  ].join("\n");

  return execFileSync("/bin/bash", ["-lc", script], {
    encoding: "utf8",
    env: { ...process.env, TARGET_WORKSPACE: workspace, TERM: "dumb" },
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function acquireLock() {
  try {
    const handle = await open(LOCK_PATH, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }

    const ownerText = await readFile(LOCK_PATH, "utf8").catch(() => "");
    const owner = Number.parseInt(ownerText.trim(), 10);
    if (Number.isInteger(owner)) {
      try {
        process.kill(owner, 0);
        throw new Error(
          `Office2 live-workspace eval is already running as PID ${owner}.`,
        );
      } catch (probeError) {
        if (probeError?.code !== "ESRCH") {
          throw probeError;
        }
      }
    }

    await rm(LOCK_PATH, { force: true });
    return acquireLock();
  }
}

function flattenGradeDetails(result) {
  const rows = [
    {
      name: result.name,
      passed: result.passed,
      score: result.score,
      evidence: result.evidence,
    },
  ];
  for (const detail of result.details ?? []) {
    rows.push(...flattenGradeDetails(detail));
  }
  return rows;
}

function addWorkspaceGuard(gradeResult, workspaceUnchanged) {
  const guard = {
    name: "workspace-unchanged",
    kind: "code",
    passed: workspaceUnchanged,
    score: workspaceUnchanged ? 1 : 0,
    label: workspaceUnchanged ? "correct" : "incorrect",
    evidence: workspaceUnchanged
      ? "Office2 Git status and target-file hash are unchanged"
      : "Office2 Git status or target-file hash changed during the eval",
  };
  const details = [...(gradeResult.details ?? []), guard];
  const passedCount = details.filter((detail) => detail.passed).length;
  return {
    ...gradeResult,
    passed: gradeResult.passed && workspaceUnchanged,
    score:
      details.length === 0
        ? 0
        : details.reduce((sum, detail) => sum + detail.score, 0) /
          details.length,
    evidence: `${passedCount}/${details.length} graders passed`,
    details,
  };
}

async function closeStream(stream) {
  stream.end();
  if (!stream.closed) {
    await once(stream, "close");
  }
}

async function main() {
  if (!process.env.COPILOT_GITHUB_TOKEN) {
    throw new Error(
      "COPILOT_GITHUB_TOKEN is required (fine-grained PAT with Copilot Requests permission).",
    );
  }

  const evalPath = path.resolve(
    process.argv[2] ?? "evals/omr-readonly/eval.yaml",
  );
  const workspace = await realpath(
    process.env.OMR_LIVE_WORKSPACE ?? EXPECTED_WORKSPACE,
  );
  if (workspace !== EXPECTED_WORKSPACE) {
    throw new Error(
      `Refusing live-workspace eval outside ${EXPECTED_WORKSPACE}; got ${workspace}.`,
    );
  }

  await acquireLock();

  const targetPath = path.join(workspace, TARGET_FILE);
  const skillPath = path.join(workspace, OMR_BUILD_SKILL);
  const initialStatus = officeGitStatus(workspace);
  if (initialStatus !== "") {
    throw new Error(
      "Office2 must start clean for this prototype. Commit or remove existing changes first.",
    );
  }

  const initialTargetHash = sha256(await readFile(targetPath));
  const loadedSpec = await loadEvalSpec(evalPath);
  const modelOverride = process.env.OMR_EVAL_MODEL?.trim();
  const spec = modelOverride
    ? {
        ...loadedSpec,
        defaults: {
          ...(loadedSpec.defaults ?? {}),
          model: modelOverride,
        },
      }
    : loadedSpec;
  const variant = process.env.OMR_EVAL_VARIANT?.trim() || "main";
  const configuredStimulus = spec.stimuli?.[0];
  if (!configuredStimulus?.prompt || !configuredStimulus.graders?.length) {
    throw new Error(`No runnable stimulus with graders found in ${evalPath}.`);
  }

  const skill = await parseSkill(skillPath);
  const executor = new CopilotSdkExecutor();
  const graderRegistry = createDefaultGraderRegistry();
  const executorRegistry = createExecutorRegistry();
  executorRegistry.register(executor);
  const projectCtx = await ProjectContext.load(process.cwd());
  const plan = await planRun({
    variants: [
      {
        name: variant,
        specs: [{ filePath: evalPath, spec }],
      },
    ],
    projectCtx,
    getExecutor: () => executor,
    models: [undefined],
    runs: 1,
    graderRegistry,
    executorRegistry,
  });
  if (plan.items.length !== 1 || plan.evals.some((entry) => entry.failure)) {
    const failures = plan.evals
      .map((entry) => entry.failure)
      .filter(Boolean)
      .join("; ");
    throw new Error(
      `Expected exactly one valid live-workspace trial; planned ${plan.items.length}. ${failures}`,
    );
  }
  const item = plan.items[0];
  const stimulus = item.stimulus;
  const outputDir = process.env.OMR_EVAL_OUTPUT_DIR
    ? path.resolve(process.env.OMR_EVAL_OUTPUT_DIR)
    : path.resolve("vally-results", "omr-live-readonly", timestamp());
  await mkdir(outputDir, { recursive: true });
  const resultsPath = path.join(outputDir, "results.jsonl");
  const markdownPath = path.join(outputDir, "eval-results.md");
  const junitPath = path.join(outputDir, "eval-results.junit.xml");
  const sessionDir = path.join(
    outputDir,
    spec.name,
    stimulus.name,
    spec.defaults?.model ?? "default-model",
    "0",
  );
  const sessionScratchDir = path.join(sessionDir, ".session-scratch");
  await mkdir(sessionDir, { recursive: true });

  const jsonlStream = createWriteStream(resultsPath, { encoding: "utf8" });
  await once(jsonlStream, "open");
  const reporters = new CompositeEvalReporter([
    new EvalJsonlReporter({ stream: jsonlStream }),
    new EvalMarkdownReporter({ outputPath: markdownPath }),
    new EvalJunitReporter({ outputPath: junitPath }),
  ]);
  await reporters.onRunStart({
    evals: plan.evals,
    totalItems: plan.totalItems,
    workers: 1,
    source: { name: "vally-live-workspace-runner", version: "1.0.0" },
    graderNames: [
      ...new Set([
        ...stimulus.graders.map((grader) => grader.type),
        "workspace-unchanged",
      ]),
    ].sort(),
  });
  await reporters.onTrialStart(item);

  let run;
  let gradeResult;
  let runError;
  const startedAt = Date.now();
  try {
    run = await runEval({
      prompt: stimulus.prompt,
      stimulus,
      skills: [skill],
      workDir: path.dirname(evalPath),
      workspace,
      executor,
      timeout: parseDuration(spec.defaults?.timeout ?? "2m"),
      model: spec.defaults?.model,
      reasoningEffort: spec.defaults?.reasoning_effort,
      environment: {
        env: {
          MS_BRANCH_ROOT: workspace,
          HARNESS_ROOT: path.join(workspace, "harness"),
          PATH: `/usr/local/bin:${process.env.PATH ?? ""}`,
          GIT_EXEC_PATH: "/usr/local/git/libexec/git-core",
        },
      },
      sessionLog: {
        rootDir: sessionScratchDir,
        executorArtifactsDir: path.join(sessionDir, "executor-artifacts"),
      },
    });

    const rawGradeResult = await gradeTrajectory(
      run.trajectory,
      stimulus.graders,
      {
        registry: graderRegistry,
        stimulus,
      },
    );
    gradeResult = {
      ...rawGradeResult,
      stimulusName: stimulus.name,
      trajectoryId: run.trajectory.id,
      timestamp: new Date(),
    };
  } catch (error) {
    runError = error;
  } finally {
    await run?.cleanup().catch(() => {});
    await executor.shutdown().catch(() => {});
  }

  const finalStatus = officeGitStatus(workspace);
  const finalTargetHash = sha256(await readFile(targetPath));
  const workspaceUnchanged =
    initialStatus === finalStatus && initialTargetHash === finalTargetHash;
  if (gradeResult) {
    gradeResult = addWorkspaceGuard(gradeResult, workspaceUnchanged);
  }

  const durationMs = Date.now() - startedAt;
  const trialResult = {
    itemId: item.id,
    durationMs,
    status: runError ? "error" : "success",
    trajectory: run?.trajectory ?? null,
    grade: gradeResult ?? null,
    ...(runError ? { error: runError.message } : {}),
    workspacePath: workspace,
  };
  await reporters.onTrialResult({ item, result: trialResult });
  const summary = plan.summarize([trialResult]);
  await reporters.onEvalComplete(summary.evals[0]);
  const artifacts = {
    jsonl: resultsPath,
    markdown: markdownPath,
    junit: junitPath,
    sessionLogsDir: outputDir,
  };
  await reporters.onRunComplete(summary, artifacts, "completed");
  await closeStream(jsonlStream);

  const nativeEventsPath = path.join(
    sessionScratchDir,
    "session-state",
    "events.jsonl",
  );
  const standardEventsPath = path.join(sessionDir, "events.jsonl");
  await copyFile(nativeEventsPath, standardEventsPath).catch(() => {});
  await writeFile(
    path.join(sessionDir, "metadata.json"),
    `${JSON.stringify(
      {
        evalName: spec.name,
        evalFilePath: evalPath,
        variant,
        stimulusName: stimulus.name,
        trialId: item.id,
        executorName: "copilot-sdk",
        status: runError ? "error" : "success",
        trajectoryId: run?.trajectory.id,
        executorSessionId: run?.trajectory.metadata?.sessionID,
        model: run?.trajectory.metadata?.model,
        workspace,
        workspaceUnchanged,
        logSource: "native",
        eventsPath: standardEventsPath,
      },
      null,
      2,
    )}\n`,
  );
  await rm(sessionScratchDir, { recursive: true, force: true });

  const result = {
    eval: spec.name,
    stimulus: stimulus.name,
    workspace,
    workspaceUnchanged,
    initialStatusHash: sha256(initialStatus),
    finalStatusHash: sha256(finalStatus),
    initialTargetHash,
    finalTargetHash,
    model: run?.trajectory.metadata?.model,
    output: run?.trajectory.output,
    metrics: run?.trajectory.metrics,
    gradeResult,
    standardArtifacts: artifacts,
    error: runError
      ? {
          name: runError.name,
          message: runError.message,
          stack: runError.stack,
        }
      : undefined,
  };
  await writeFile(
    path.join(outputDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );

  if (run?.trajectory) {
    await writeFile(
      path.join(outputDir, "trajectory.json"),
      `${JSON.stringify(run.trajectory, null, 2)}\n`,
    );
  }

  console.log(`Workspace: ${workspace}`);
  console.log(`Workspace unchanged: ${workspaceUnchanged ? "yes" : "NO"}`);
  if (run?.trajectory.metadata?.model) {
    console.log(`Model: ${run.trajectory.metadata.model}`);
  }
  if (run?.trajectory.output) {
    console.log(`\nAgent output:\n${run.trajectory.output.trim()}\n`);
  }
  if (gradeResult) {
    console.log("Graders:");
    for (const row of flattenGradeDetails(gradeResult).slice(1)) {
      console.log(
        `  ${row.passed ? "PASS" : "FAIL"} ${row.name}: ${row.evidence}`,
      );
    }
  }
  console.log(`\nResults: ${outputDir}`);

  if (runError) {
    throw runError;
  }
  if (!workspaceUnchanged) {
    throw new Error(
      "The live Office2 workspace changed during the read-only eval. Changes were preserved for inspection.",
    );
  }
  if (!gradeResult?.passed) {
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await rm(LOCK_PATH, { force: true });
}
