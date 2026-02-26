# BANSOU Action

Validate BANSOU attestation JWTs in pull requests. This action fails the job when a PR does not include a valid attestation for the required quiz.

## Usage

```yaml
on: pull_request

jobs:
  bansou:
    name: BANSOU Gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bansou-dev/bansou-action@v1
        with:
          issuer: https://attest.example.com
          jwks_url: https://attest.example.com/.well-known/jwks.json
          required_quiz_id: core-pr
          require_file_coverage: true
          github_token: ${{ github.token }}
```

## Inputs

- `issuer` (required): Expected JWT issuer.
- `jwks_url` (required): JWKS endpoint URL for signature verification.
- `required_quiz_id` (required): Required `quiz_id` that must exist in at least one valid attestation.
- `attestations_dir` (optional, default `.bansou/attestations`): Directory to scan for `*.jwt` files.
- `fail_on_missing` (optional, default `true`): Fail if no JWT files are found.
- `require_file_coverage` (optional, default `false`): Require at least one valid attestation (`required_quiz_id`) for each changed file in the PR.
- `github_token` (optional): Token for PR file listing API. Use `${{ github.token }}` when `require_file_coverage` is enabled.
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
- JWTs that are valid but do not match this PR context (`repo`, `commit`, `sub`) are ignored.
- If any JWT is malformed/expired/signature-invalid, the job fails.
- At least one context-matching valid JWT must satisfy:
  - `payload.quiz_id === required_quiz_id`
- If no JWTs are found and `fail_on_missing` is true, the job fails.
- If `require_file_coverage` is true, every changed file in the PR must be covered by at least one valid attestation artifact path.
- Coverage check ignores generated BANSOU artifacts (`attestations_dir`配下, `.bansou/checklists/**`, `*.jwt`).

## Required checks setup

To enforce "attestation required for merge", add the workflow job (for example `bansou`) as a required status check in GitHub branch protection settings.

## Publishing (recommended)

1. Build and commit `dist/` (GitHub Actions executes the bundled output).
2. Create a `v1` tag and push it.
3. Keep moving the `v1` tag to the latest compatible release.

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
