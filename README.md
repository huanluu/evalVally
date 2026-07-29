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

The read-only OMR prototype runs Vally core directly against the existing
Office2 checkout because OMR does not fully support Git worktrees:

```sh
COPILOT_GITHUB_TOKEN=your-token npm run eval:omr-readonly
```

This runner is intentionally restricted to `/Volumes/Office/Office2/src`,
requires a clean checkout, permits only one concurrent run, never launches a
build, and fails if the repository status or target file changes. It does not
revert changes. This live OMR runner is currently macOS-only; the generic Vally
smoke evals remain cross-platform.

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

The live runner currently supports one stimulus and one trial at a time. It
does not use the CLI experiment/matrix runner, worker pool, retries, pass@k, or
flakiness aggregation.

### Live model comparison

The experiment contract in
`experiments/omr-model-comparison.experiment.yaml` compares Claude Opus 5,
GPT-5.6 Terra, and GPT-5.6 Sol against the same live Office2 checkout. Sol is
the baseline. Variants run sequentially, then Vally compares each treatment
against the baseline:

```sh
COPILOT_GITHUB_TOKEN=your-token npm run eval:omr-models
```

The validated Gemini-judged run is summarized visually in
[`docs/gemini-model-comparison.html`](docs/gemini-model-comparison.html).

## Visual explainer

Open [`docs/index.html`](docs/index.html) to see how the pipeline works, what
each smoke case validates, and what this prototype does and does not prove.

## GitHub Actions

The workflow in `.github/workflows/vally.yml` validates the eval spec on every
push and pull request. It then executes the smoke suite using the repository
secret `COPILOT_GITHUB_TOKEN` and uploads the complete Vally results.
