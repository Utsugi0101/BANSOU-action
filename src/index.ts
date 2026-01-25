import 'dotenv/config';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import * as fs from 'fs/promises';
import * as path from 'path';

type VerifyResult = {
  file: string;
  ok: boolean;
  reason?: string;
  payload?: JWTPayload;
};

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

async function collectJwtFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jwt')) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

async function verifyToken(
  filePath: string,
  jwksUrl: string,
  issuer: string,
  expectedRepo: string,
  expectedCommit: string,
  expectedAuthor: string
): Promise<VerifyResult> {
  let token: string;
  try {
    token = (await fs.readFile(filePath, 'utf8')).trim();
  } catch (err) {
    return { file: filePath, ok: false, reason: `failed to read token: ${(err as Error).message}` };
  }

  if (!token) {
    return { file: filePath, ok: false, reason: 'token is empty' };
  }

  try {
    const jwks = createRemoteJWKSet(new URL(jwksUrl));
    const { payload } = await jwtVerify(token, jwks, { issuer });

    if (payload.repo !== expectedRepo) {
      return { file: filePath, ok: false, reason: `repo mismatch: ${payload.repo} !== ${expectedRepo}` };
    }

    if (payload.commit !== expectedCommit) {
      return { file: filePath, ok: false, reason: `commit mismatch: ${payload.commit} !== ${expectedCommit}` };
    }

    if (payload.sub !== expectedAuthor) {
      return { file: filePath, ok: false, reason: `author mismatch: ${payload.sub} !== ${expectedAuthor}` };
    }

    return { file: filePath, ok: true, payload };
  } catch (err) {
    const message = (err as Error).message || String(err);
    if (message.toLowerCase().includes('jwt expired')) {
      return { file: filePath, ok: false, reason: 'token expired' };
    }
    return { file: filePath, ok: false, reason: `signature or claim verification failed: ${message}` };
  }
}

async function run(): Promise<void> {
  const issuer = core.getInput('issuer', { required: true });
  const jwksUrl = core.getInput('jwks_url', { required: true });
  const requiredQuizId = core.getInput('required_quiz_id', { required: true });
  const attestationsDir = core.getInput('attestations_dir') || '.bansou/attestations';
  const failOnMissing = parseBoolean(core.getInput('fail_on_missing'), true);

  const context = github.context;
  const prHeadSha = context.payload.pull_request?.head?.sha;
  const prAuthor = context.payload.pull_request?.user?.login;
  const repoFullName = context.payload.repository?.full_name;

  const headSha = core.getInput('head_sha') || prHeadSha || '';
  const author = core.getInput('pr_author') || prAuthor || context.actor || '';
  const repo = core.getInput('repo') || repoFullName || process.env.GITHUB_REPOSITORY || '';

  if (!headSha) {
    core.setFailed('head_sha is required but was not provided and could not be inferred from the PR context');
    return;
  }

  if (!author) {
    core.setFailed('pr_author is required but was not provided and could not be inferred from the PR context');
    return;
  }

  if (!repo) {
    core.setFailed('repo is required but was not provided and could not be inferred from the environment');
    return;
  }

  core.info(`Searching attestations in ${attestationsDir}`);
  const files = await collectJwtFiles(attestationsDir);

  if (files.length === 0) {
    const message = 'No attestations found';
    if (failOnMissing) {
      core.error(message);
      core.setFailed(message);
      return;
    }
    core.warning(message);
    return;
  }

  core.info(`Found ${files.length} attestation file(s)`);

  let invalidCount = 0;
  let requiredQuizFound = false;

  for (const file of files) {
    const result = await verifyToken(file, jwksUrl, issuer, repo, headSha, author);
    if (!result.ok) {
      invalidCount += 1;
      core.error(`${path.relative(process.cwd(), result.file)}: ${result.reason}`);
      continue;
    }

    if (result.payload?.quiz_id === requiredQuizId) {
      requiredQuizFound = true;
    }
  }

  if (invalidCount > 0) {
    core.setFailed(`Invalid attestations: ${invalidCount}`);
    return;
  }

  if (!requiredQuizFound) {
    core.error(`required quiz_id missing: ${requiredQuizId}`);
    core.setFailed('required quiz_id missing');
    return;
  }

  core.info('BANSOU attestation verified');
}

run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
