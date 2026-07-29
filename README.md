# Vally pipeline prototype

This repository demonstrates a minimal [Vally](https://microsoft.github.io/vally/)
pipeline for evaluating an AI agent:

```text
stimulus -> Copilot executor -> trajectory -> deterministic graders -> score
```

The smoke suite covers three behaviors:

- generating valid structured data
- generating code that passes an executable behavior check
- retaining information across conversation turns

## Run locally

Prerequisites:

- Node.js 22 or newer
- a fine-grained GitHub PAT with **Account > Copilot Requests** permission

```sh
npm ci
npm run lint
COPILOT_GITHUB_TOKEN=your-token npm run eval
```

Results, trajectories, JUnit output, and captured artifacts are written under
`vally-results/`.

## Experimental live OMR workspace

The `omr-live` Vally backend runs the built-in `copilot-sdk` executor directly
against the existing Office2 checkout because OMR does not fully support Git
worktrees:

```sh
COPILOT_GITHUB_TOKEN=your-token npm run eval:omr-readonly
```

The backend is intentionally restricted to `/Volumes/Office/Office2/src`,
requires a clean checkout, serializes trials, and fails if the repository status
or target file changes unexpectedly. It does not silently revert agent changes.
The backend is currently macOS-only; the generic Vally smoke evals remain
cross-platform.

Each run writes Vally-compatible output:

```text
vally-results/omr-live-readonly/<timestamp>/
├── results.jsonl
├── eval-results.md
├── eval-results.junit.xml
└── omr-live-readonly/<stimulus>/default-model/0/
    ├── events.jsonl
    └── metadata.json
```

The output can be opened with `vally serve`, imported with `vally ingest`,
re-graded with `vally grade`, and compared with another independent run using
`vally compare`.

Execution and reporting are owned by stock `vally eval` / `vally experiment
run`; the plugin owns only the live Office workspace lifecycle.

### Live model comparison

The experiment contract in
`experiments/omr-model-comparison.experiment.yaml` compares Claude Opus 5,
GPT-5.6 Terra, and GPT-5.6 Sol against the same live Office2 checkout. Sol is the baseline. The backend serializes model trials because they share one
live checkout:

```sh
COPILOT_GITHUB_TOKEN=your-token npm run eval:omr-models
```

The validated Gemini-judged run is summarized visually in
[`docs/gemini-model-comparison.html`](docs/gemini-model-comparison.html).

### Gate-cleanup bug fixture

`evals/omr-gate-cleanup/eval.yaml` presents a snapshot of ADO work item
11659378 to the measured model. The local fixture
`fixtures/gate-cleanup-lock-scope.yaml` tells the backend how to reverse the
merged fix on local `main`; a separate setup Copilot session resolves revert
conflicts when necessary. The measured session is forbidden from reading Git
diff/history, and a hidden program grader checks the expected gate cleanup,
RAII lock scope, unrelated gates, and file-change boundary. The backend restores
the original Office2 source and branch after the run.

## Visual explainer

Open [`docs/index.html`](docs/index.html) to see how the pipeline works, what
each smoke case validates, and what this prototype does and does not prove.

## GitHub Actions

The workflow in `.github/workflows/vally.yml` validates the eval spec on every
push and pull request. It then executes the smoke suite using the repository
secret `COPILOT_GITHUB_TOKEN` and uploads the complete Vally results.
