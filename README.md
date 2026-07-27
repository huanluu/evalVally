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

## GitHub Actions

The workflow in `.github/workflows/vally.yml` validates the eval spec on every
push and pull request. It then executes the smoke suite using the repository
secret `COPILOT_GITHUB_TOKEN` and uploads the complete Vally results.
