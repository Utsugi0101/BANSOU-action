# BANSOU Action

Validate BANSOU attestation JWTs in pull requests. This action fails the job when a PR does not include a valid attestation for the required quiz.

## Usage

```yaml
on: pull_request

jobs:
  bansou:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bansou-dev/bansou-action@v1
        with:
          issuer: https://attest.example.com
          jwks_url: https://attest.example.com/.well-known/jwks.json
          required_quiz_id: core-pr
```

## Inputs

- `issuer` (required): Expected JWT issuer.
- `jwks_url` (required): JWKS endpoint URL for signature verification.
- `required_quiz_id` (required): Required `quiz_id` that must exist in at least one valid attestation.
- `attestations_dir` (optional, default `.bansou/attestations`): Directory to scan for `*.jwt` files.
- `fail_on_missing` (optional, default `true`): Fail if no JWT files are found.
- `head_sha` (optional): PR head SHA to verify against. Defaults to the PR head SHA from GitHub context.
- `pr_author` (optional): PR author (expected `sub`). Defaults to the PR author from GitHub context.
- `repo` (optional): Repository full name (`owner/repo`). Defaults to `GITHUB_REPOSITORY`.

## Attestation file layout

The action recursively searches `attestations_dir` for `*.jwt` files, for example:

```
.bansou/attestations/<commit_sha>/<quiz_id>.jwt
```

## Verification rules (MVP)

- All discovered JWTs are verified with `jose` using the provided JWKS URL and issuer.
- Each JWT must satisfy:
  - `payload.repo === repo`
  - `payload.commit === head_sha`
  - `payload.sub === pr_author`
- At least one valid JWT must satisfy:
  - `payload.quiz_id === required_quiz_id`
- If any JWT is invalid, the job fails and the reason is logged.
- If no JWTs are found and `fail_on_missing` is true, the job fails.

## Required checks setup

To enforce "attestation required for merge", add the workflow job (for example `bansou`) as a required status check in GitHub branch protection settings.

## Local run (basic)

You can run the action logic locally for debugging:

```bash
npm install
npm run build
cat > .env <<'ENV'
INPUT_ISSUER=https://attest.example.com
INPUT_JWKS_URL=https://attest.example.com/.well-known/jwks.json
INPUT_REQUIRED_QUIZ_ID=core-pr
GITHUB_REPOSITORY=owner/repo
GITHUB_EVENT_PATH=/path/to/event.json
ENV
node dist/index.js
```

Note: The action loads `.env` automatically for local runs. You must provide the `INPUT_*` variables (and a PR-style event JSON at `GITHUB_EVENT_PATH`) and ensure the JWT files exist under `.bansou/attestations`.
