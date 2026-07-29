import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  gradeTrajectory,
  parseSkill,
  runEval,
} from "@microsoft/vally";
import { CopilotSdkExecutor } from "@microsoft/vally/executor";
import {
  exportArtifactsFromDir,
} from "@microsoft/vally/workspace";
import YAML from "yaml";

const DEFAULT_CHECKOUT = "/Volumes/Office/Office2/src";
const DEFAULT_TARGET_FILE =
  "documentmru/aggregatedmru/AddRecentItemRequests.cpp";
const LOCK_PATH = "/tmp/vally-office2-live-workspace.lock";
const PLUGIN_ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function scalarConfig(config, key, fallback) {
  const value = config[key];
  if (value === undefined) {
    return fallback;
  }
  if (Array.isArray(value)) {
    throw new Error(`OMR backend argument "${key}" must be specified once.`);
  }
  return value;
}

function runOfficeGit(checkout, args, options = {}) {
  const script = [
    "set -e",
    'cd "$OMR_CHECKOUT"',
    'source "$OMR_CHECKOUT/init.sh" >/dev/null',
    "PATH=/usr/local/bin:$PATH",
    "GIT_EXEC_PATH=/usr/local/git/libexec/git-core",
    "export PATH GIT_EXEC_PATH",
    'git --no-pager "$@"',
  ].join("\n");
  return execFileSync(
    "/bin/zsh",
    ["-lc", script, "omr-live-git", ...args],
    {
    encoding: "utf8",
    env: {
      ...process.env,
      OMR_CHECKOUT: checkout,
      TERM: "dumb",
      ...(options.env ?? {}),
    },
    maxBuffer: 16 * 1024 * 1024,
    ...Object.fromEntries(
      Object.entries(options).filter(([key]) => key !== "env"),
    ),
    },
  );
}

function gitStatus(checkout) {
  return runOfficeGit(checkout, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
}

function gitHead(checkout) {
  return runOfficeGit(checkout, ["rev-parse", "HEAD"]).trim();
}

function currentBranch(checkout) {
  return runOfficeGit(checkout, ["branch", "--show-current"]).trim();
}

function statusPaths(status) {
  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1));
}

function shellSucceeded(checkout, args) {
  try {
    runOfficeGit(checkout, args, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function acquireProcessLock() {
  try {
    const handle = await open(LOCK_PATH, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  const ownerText = await readFile(LOCK_PATH, "utf8").catch(() => "");
  const owner = Number.parseInt(ownerText.trim(), 10);
  if (Number.isInteger(owner)) {
    try {
      process.kill(owner, 0);
      throw new Error(
        `Office2 live-workspace eval is already running as PID ${owner}.`,
      );
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
  await rm(LOCK_PATH, { force: true });
  await acquireProcessLock();
}

function mergeEnvironment(environment, checkout) {
  if (
    environment?.git ||
    (environment?.files?.length ?? 0) > 0 ||
    (environment?.commands?.length ?? 0) > 0
  ) {
    throw new Error(
      "The OMR live backend does not allow environment.git, environment.files, " +
        "or environment.commands because they can mutate the production checkout. " +
        "Use backend-owned preparation instead.",
    );
  }
  return {
    ...(environment ?? {}),
    skills: undefined,
    env: {
      ...(environment?.env ?? {}),
      MS_BRANCH_ROOT: checkout,
      PATH: `/usr/local/bin:${process.env.PATH ?? ""}`,
      GIT_EXEC_PATH: "/usr/local/git/libexec/git-core",
      EVALVALLY_ROOT: PLUGIN_ROOT,
    },
  };
}

async function loadDeclaredSkills(environment, baseDir) {
  const refs = environment?.skills ?? [];
  return Promise.all(
    refs.map(async (ref) => {
      const directory = path.isAbsolute(ref)
        ? ref
        : path.resolve(baseDir, ref);
      return parseSkill(path.join(directory, "SKILL.md"));
    }),
  );
}

export function addWorkspaceGuard(gradeResult, unchanged) {
  const guard = {
    name: "workspace-unchanged",
    kind: "code",
    passed: unchanged,
    score: unchanged ? 1 : 0,
    label: unchanged ? "correct" : "incorrect",
    evidence: unchanged
      ? "Office2 HEAD, Git status, and target-file hash are unchanged"
      : "Office2 HEAD, Git status, or target-file hash changed during the trial",
  };
  if (!gradeResult) {
    return guard;
  }
  const details = [...(gradeResult.details ?? []), guard];
  const passedCount = details.filter((detail) => detail.passed).length;
  return {
    ...gradeResult,
    passed: gradeResult.passed && unchanged,
    score:
      details.reduce((sum, detail) => sum + detail.score, 0) / details.length,
    evidence: `${passedCount}/${details.length} graders passed`,
    details,
  };
}

class OmrLiveBackend {
  name = "omr-live";
  checkout;
  targetFile;
  initialHead;
  fixture;
  fixtureFiles = [];
  pristineFiles = new Map();
  regressionFiles = new Map();
  regressionStatus = "";
  prepared = false;
  disposed = false;
  lockHeld = false;
  queue = Promise.resolve();

  async prepare(config) {
    if (this.prepared) {
      return;
    }
    if (process.platform !== "darwin") {
      throw new Error("The OMR live backend currently supports macOS only.");
    }
    this.checkout = await realpath(
      scalarConfig(config, "checkout", DEFAULT_CHECKOUT),
    );
    if (this.checkout !== DEFAULT_CHECKOUT) {
      throw new Error(
        `Refusing OMR live execution outside ${DEFAULT_CHECKOUT}; got ${this.checkout}.`,
      );
    }
    this.targetFile = scalarConfig(
      config,
      "target-file",
      DEFAULT_TARGET_FILE,
    );
    const fixturePath = scalarConfig(config, "fixture", "");
    if (fixturePath) {
      this.fixture = await this.loadFixture(fixturePath, config);
    }
    await acquireProcessLock();
    this.lockHeld = true;
    try {
      const status = gitStatus(this.checkout);
      if (status !== "") {
        throw new Error(
          "Office2 must be clean before an OMR live eval. Existing changes were not modified.",
        );
      }
      await readFile(path.join(this.checkout, this.targetFile));
      this.initialHead = gitHead(this.checkout);
      if (this.fixture) {
        const branch = currentBranch(this.checkout);
        if (branch !== this.fixture.sourceBranch) {
          throw new Error(
            `Case fixture requires branch "${this.fixture.sourceBranch}", but Office2 is on "${branch}".`,
          );
        }
        await this.prepareFixture();
      }
      this.prepared = true;
    } catch (error) {
      await this.releaseProcessLock();
      throw error;
    }
  }

  async loadFixture(fixturePath, config) {
    const resolvedPath = await realpath(
      path.resolve(process.cwd(), fixturePath),
    );
    const fixture = YAML.parse(await readFile(resolvedPath, "utf8"));
    if (fixture.setup_mode !== "revert_and_rebuild") {
      throw new Error(
        `OMR backend fixture currently supports revert_and_rebuild, got ${fixture.setup_mode}.`,
      );
    }
    if (
      !Array.isArray(fixture.revert_commits) ||
      fixture.revert_commits.length === 0
    ) {
      throw new Error("Case fixture has no revert_commits.");
    }
    const files = [
      ...new Set(
        fixture.revert_commits.flatMap(
          (commit) => commit.files_touched ?? [],
        ),
      ),
    ];
    if (files.length === 0) {
      throw new Error("Case fixture has no files_touched.");
    }
    return {
      fixturePath: resolvedPath,
      fixture,
      files,
      sourceBranch: scalarConfig(
        config,
        "source-branch",
        fixture.source_branch ?? "main",
      ),
      setupModel: scalarConfig(config, "setup-model", "gpt-5.6-sol"),
    };
  }

  async prepareFixture() {
    this.fixtureFiles = this.fixture.files;
    for (const relativePath of this.fixtureFiles) {
      this.pristineFiles.set(
        relativePath,
        await readFile(path.join(this.checkout, relativePath)),
      );
    }

    const revertShas = this.fixture.fixture.revert_commits.map(
      (commit) => commit.sha,
    );
    let revertFailed = false;
    try {
      runOfficeGit(this.checkout, [
        "revert",
        "--no-commit",
        ...revertShas,
      ]);
    } catch {
      revertFailed = true;
    }

    const unmerged = runOfficeGit(this.checkout, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ])
      .trim()
      .split("\n")
      .filter(Boolean);
    if (revertFailed && unmerged.length === 0) {
      await this.restorePristineFixture();
      throw new Error(
        "Reverting the fixture failed without merge conflicts; refusing to infer a setup state.",
      );
    }
    if (unmerged.length > 0) {
      await this.resolveFixtureConflicts(unmerged);
    }
    const remaining = runOfficeGit(this.checkout, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]).trim();
    if (remaining) {
      await this.restorePristineFixture();
      throw new Error(
        `Setup conflict resolver left unresolved files: ${remaining}`,
      );
    }

    for (const relativePath of this.fixtureFiles) {
      this.regressionFiles.set(
        relativePath,
        await readFile(path.join(this.checkout, relativePath)),
      );
    }

    if (!shellSucceeded(this.checkout, ["revert", "--abort"])) {
      await this.restorePristineFixture();
      throw new Error("Could not abort the temporary setup revert cleanly.");
    }
    await this.writeFiles(this.regressionFiles);
    runOfficeGit(this.checkout, [
      "restore",
      "--staged",
      "--",
      ...this.fixtureFiles,
    ]);
    this.regressionStatus = gitStatus(this.checkout);
    const changed = new Set(statusPaths(this.regressionStatus));
    if (
      this.fixtureFiles.some((relativePath) => !changed.has(relativePath))
    ) {
      await this.restorePristineFixture();
      throw new Error(
        "Prepared regression does not modify every expected fixture file.",
      );
    }
    const regressionText = (
      await Promise.all(
        this.fixtureFiles.map((relativePath) =>
          readFile(path.join(this.checkout, relativePath), "utf8"),
        ),
      )
    ).join("\n");
    if (!regressionText.includes("IsOptimisticUIUpdateEnabled")) {
      await this.restorePristineFixture();
      throw new Error(
        "Prepared case does not reintroduce IsOptimisticUIUpdateEnabled.",
      );
    }
  }

  async resolveFixtureConflicts(unmerged) {
    const resolver = new CopilotSdkExecutor();
    const guidance = this.fixture.fixture.revert_commits
      .map((commit) => commit.description)
      .join("; ");
    const prompt = [
      "Resolve only the current git revert conflicts for an evaluation fixture.",
      `Conflicted files: ${unmerged.join(", ")}.`,
      `The reverted fix was: ${guidance}.`,
      "Preserve newer mainline code, especially std::scoped_lock spelling.",
      "Reintroduce the old if (Gates::IsOptimisticUIUpdateEnabled()) wrappers",
      "so the ChangeGate is present again. Do not remove the gate. Do not commit.",
      "Do not inspect git history, the original fix commit, or unrelated files.",
      "Finish with all conflict markers removed and all conflicted files staged.",
    ].join("\n");
    try {
      await resolver.execute(
        { name: "prepare-revert-conflicts", prompt },
        {
          timeout: 5 * 60 * 1000,
          workDir: this.checkout,
          model: this.fixture.setupModel,
          env: mergeEnvironment(undefined, this.checkout).env,
        },
      );
    } finally {
      await resolver.shutdown().catch(() => {});
    }
  }

  async writeFiles(fileMap) {
    for (const [relativePath, content] of fileMap) {
      const destination = path.join(this.checkout, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
  }

  async restorePristineFixture() {
    shellSucceeded(this.checkout, ["revert", "--abort"]);
    if (this.pristineFiles.size > 0) {
      await this.writeFiles(this.pristineFiles);
      runOfficeGit(this.checkout, [
        "restore",
        "--staged",
        "--",
        ...this.fixtureFiles,
      ]);
    }
  }

  async restoreRegressionFixture() {
    await this.writeFiles(this.regressionFiles);
    runOfficeGit(this.checkout, [
      "restore",
      "--staged",
      "--",
      ...this.fixtureFiles,
    ]);
  }

  async acquireTrialSlot() {
    let release;
    const previous = this.queue;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  async snapshot() {
    return {
      head: gitHead(this.checkout),
      status: gitStatus(this.checkout),
      targetHash: sha256(
        await readFile(path.join(this.checkout, this.targetFile)),
      ),
    };
  }

  async runTrial(item, options) {
    if (!this.prepared || this.disposed) {
      throw new Error("OMR live backend is not prepared or has been shut down.");
    }
    const releaseSlot = await this.acquireTrialSlot();
    let runResult;
    let cleanupCalled = false;
    try {
      const before = await this.snapshot();
      const expectedStatus = this.fixture ? this.regressionStatus : "";
      if (
        before.head !== this.initialHead ||
        before.status !== expectedStatus
      ) {
        throw new Error(
          "Office2 changed outside the expected eval fixture state. Refusing to continue.",
        );
      }

      await options.context.onPhase?.("preparing");
      const baseDir =
        options.runOptions.baseDir ?? options.runOptions.workDir;
      const declaredSkills = await loadDeclaredSkills(
        options.runOptions.environment,
        baseDir,
      );
      const environment = mergeEnvironment(
        options.runOptions.environment,
        this.checkout,
      );
      const stimulus = {
        ...options.runOptions.stimulus,
        environment,
      };
      await options.context.onPhase?.("running-prompt");
      runResult = await runEval({
        ...options.runOptions,
        stimulus,
        skills: [...options.runOptions.skills, ...declaredSkills],
        environment,
        workspace: this.checkout,
      });

      let gradeResult;
      if (!options.skipGrade && options.graderConfigs.length > 0) {
        gradeResult = await gradeTrajectory(
          runResult.trajectory,
          options.graderConfigs,
          options.gradeOptions,
        );
        gradeResult = {
          ...gradeResult,
          stimulusName: item.stimulus.name,
          trajectoryId: runResult.trajectory.id,
          timestamp: new Date(),
        };
      }

      const after = await this.snapshot();
      if (this.fixture) {
        const allowed = new Set(this.fixtureFiles);
        const touched = statusPaths(after.status);
        const scopeOk = touched.every((relativePath) =>
          allowed.has(relativePath),
        );
        gradeResult = addFixtureScopeGuard(gradeResult, scopeOk, touched);
      } else {
        const unchanged =
          before.head === after.head &&
          before.status === after.status &&
          before.targetHash === after.targetHash;
        gradeResult = addWorkspaceGuard(gradeResult, unchanged);
      }

      const cleanup = async () => {
        if (cleanupCalled) {
          return;
        }
        cleanupCalled = true;
        await runResult.cleanup().catch(() => {});
        if (this.fixture) {
          await this.restoreRegressionFixture();
        }
        releaseSlot();
      };
      return {
        result: {
          status: "success",
          trajectory: runResult.trajectory,
          workDir: runResult.workDir,
          gradeResult,
        },
        exportWorkspace: async (selection, targetDir) => {
          if (selection.kind === "workspace") {
            return {
              files: [],
              incomplete: true,
              failures: [
                {
                  message:
                    "Exporting the full production Office2 checkout is disabled.",
                },
              ],
              recovery: { kind: "path", path: this.checkout },
            };
          }
          return exportArtifactsFromDir({
            workspaceDir: this.checkout,
            targetDir,
            include: selection.include,
            exclude: selection.exclude,
          });
        },
        cleanup,
      };
    } catch (error) {
      if (runResult) {
        await runResult.cleanup().catch(() => {});
      }
      releaseSlot();
      const message = error instanceof Error ? error.message : String(error);
      return {
        result: {
          status: "error",
          error: {
            message,
            ...(error instanceof Error && error.stack
              ? { stack: error.stack }
              : {}),
            retryable: false,
          },
          workDir: this.checkout,
        },
        cleanup: async () => {},
      };
    }
  }

  async gradeTrial(options) {
    try {
      const result = await gradeTrajectory(
        options.trajectory,
        options.graderConfigs,
        options.gradeOptions,
      );
      return {
        result: {
          status: "success",
          trajectory: options.trajectory,
          gradeResult: {
            ...result,
            stimulusName:
              options.gradeOptions.stimulus?.name ??
              options.trajectory.stimulus.name,
            trajectoryId: options.trajectory.id,
            timestamp: new Date(),
          },
        },
        cleanup: async () => {},
      };
    } catch (error) {
      return {
        result: {
          status: "error",
          error: {
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
          trajectory: options.trajectory,
        },
        cleanup: async () => {},
      };
    }
  }

  async releaseProcessLock() {
    if (!this.lockHeld) {
      return;
    }
    this.lockHeld = false;
    await rm(LOCK_PATH, { force: true });
  }

  async shutdown() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.queue;
    if (this.fixture) {
      await this.restorePristineFixture();
      const restoredStatus = gitStatus(this.checkout);
      if (restoredStatus !== "") {
        throw new Error(
          "OMR fixture cleanup did not restore a clean Office2 checkout.",
        );
      }
    }
    await this.releaseProcessLock();
  }
}

export function addFixtureScopeGuard(gradeResult, scopeOk, touched) {
  const guard = {
    name: "fixture-change-scope",
    kind: "code",
    passed: scopeOk,
    score: scopeOk ? 1 : 0,
    label: scopeOk ? "correct" : "incorrect",
    evidence: scopeOk
      ? `All changes stayed within fixture files: ${touched.join(", ")}`
      : `Changes escaped fixture scope: ${touched.join(", ")}`,
  };
  const details = [...(gradeResult?.details ?? []), guard];
  return {
    ...(gradeResult ?? {
      name: "trajectory-grade",
      kind: "code",
      stimulusName: "eval",
      trajectoryId: "",
      timestamp: new Date(),
    }),
    passed: (gradeResult?.passed ?? true) && scopeOk,
    score:
      details.reduce((sum, detail) => sum + detail.score, 0) / details.length,
    evidence: `${details.filter((detail) => detail.passed).length}/${details.length} graders passed`,
    details,
  };
}

export function registerBackends(registry) {
  process.env.EVALVALLY_ROOT = PLUGIN_ROOT;
  registry.register({
    name: "omr-live",
    create: () => new OmrLiveBackend(),
  });
}
