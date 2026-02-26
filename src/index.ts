import 'dotenv/config';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type VerifyStatus = 'valid' | 'ignored' | 'invalid';

type VerifyResult = {
  file: string;
  status: VerifyStatus;
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

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } | undefined {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    return undefined;
  }
  return { owner, repo };
}

function getArtifactPath(payload: JWTPayload): string | undefined {
  const artifact = (payload as Record<string, unknown>).artifact;
  if (typeof artifact !== 'object' || artifact === null) {
    return undefined;
  }
  const record = artifact as Record<string, unknown>;
  return typeof record.path === 'string' && record.path ? record.path : undefined;
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
    return { file: filePath, status: 'invalid', reason: `failed to read token: ${(err as Error).message}` };
  }

  if (!token) {
    return { file: filePath, status: 'invalid', reason: 'token is empty' };
  }

  try {
    const jwks = createRemoteJWKSet(new URL(jwksUrl));
    const { payload } = await jwtVerify(token, jwks, { issuer });

    if (payload.repo !== expectedRepo) {
      return {
        file: filePath,
        status: 'ignored',
        reason: `repo mismatch: ${payload.repo} !== ${expectedRepo}`,
      };
    }

    if (payload.commit !== expectedCommit) {
      const candidate = typeof payload.commit === 'string' ? payload.commit : '';
      const isOk = candidate ? await isAncestorCommit(candidate, expectedCommit) : false;
      if (!isOk) {
        return {
          file: filePath,
          status: 'ignored',
          reason: `commit mismatch: ${payload.commit} !== ${expectedCommit}`,
        };
      }
      core.warning(`commit mismatch accepted (ancestor): ${candidate} -> ${expectedCommit}`);
    }

    if (payload.sub !== expectedAuthor) {
      return {
        file: filePath,
        status: 'ignored',
        reason: `author mismatch: ${payload.sub} !== ${expectedAuthor}`,
      };
    }

    return { file: filePath, status: 'valid', payload };
  } catch (err) {
    const message = (err as Error).message || String(err);
    if (message.toLowerCase().includes('jwt expired')) {
      return { file: filePath, status: 'invalid', reason: 'token expired' };
    }
    return { file: filePath, status: 'invalid', reason: `signature or claim verification failed: ${message}` };
  }
}

async function isAncestorCommit(candidate: string, headSha: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', candidate, headSha], {
      cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    });
    return true;
  } catch {
    return false;
  }
}

async function collectChangedFiles(
  repoFullName: string,
  githubToken: string,
  pullNumber?: number,
  baseSha?: string,
  headSha?: string
): Promise<string[]> {
  if (pullNumber && githubToken) {
    const parsed = parseRepoFullName(repoFullName);
    if (!parsed) {
      throw new Error(`invalid repo full name: ${repoFullName}`);
    }

    const octokit = github.getOctokit(githubToken);
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: parsed.owner,
      repo: parsed.repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    return files
      .map((file) => file.filename)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
  }

  if (baseSha && headSha) {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${baseSha}..${headSha}`], {
      cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  return [];
}

async function run(): Promise<void> {
  const issuer = core.getInput('issuer', { required: true });
  const jwksUrl = core.getInput('jwks_url', { required: true });
  const requiredQuizId = core.getInput('required_quiz_id', { required: true });
  const attestationsDir = core.getInput('attestations_dir') || '.bansou/attestations';
  const failOnMissing = parseBoolean(core.getInput('fail_on_missing'), true);
  const requireFileCoverage = parseBoolean(core.getInput('require_file_coverage'), false);
  const githubToken = core.getInput('github_token') || process.env.GITHUB_TOKEN || '';

  const context = github.context;
  const prHeadSha = context.payload.pull_request?.head?.sha;
  const prBaseSha = context.payload.pull_request?.base?.sha;
  const prNumber = context.payload.pull_request?.number;
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
  let ignoredCount = 0;
  const validResults: VerifyResult[] = [];

  for (const file of files) {
    const result = await verifyToken(file, jwksUrl, issuer, repo, headSha, author);
    if (result.status === 'invalid') {
      invalidCount += 1;
      core.error(`${path.relative(process.cwd(), result.file)}: ${result.reason}`);
      continue;
    }

    if (result.status === 'ignored') {
      ignoredCount += 1;
      core.info(`${path.relative(process.cwd(), result.file)}: ignored (${result.reason})`);
      continue;
    }

    validResults.push(result);
  }

  if (invalidCount > 0) {
    core.setFailed(`Invalid attestations: ${invalidCount}`);
    return;
  }

  if (validResults.length === 0) {
    core.setFailed('No attestations matched the current PR context (repo/commit/author).');
    return;
  }

  const requiredQuizResults = validResults.filter((result) => result.payload?.quiz_id === requiredQuizId);
  if (requiredQuizResults.length === 0) {
    core.error(`required quiz_id missing: ${requiredQuizId}`);
    core.setFailed('required quiz_id missing');
    return;
  }

  if (requireFileCoverage) {
    const changedFiles = await collectChangedFiles(
      repo,
      githubToken,
      typeof prNumber === 'number' ? prNumber : undefined,
      prBaseSha,
      headSha
    );

    if (changedFiles.length === 0) {
      core.setFailed(
        'require_file_coverage is enabled, but changed files could not be determined. Provide github_token or ensure base/head commits are available.'
      );
      return;
    }

    const coveredPaths = new Set<string>();
    for (const result of requiredQuizResults) {
      if (!result.payload) {
        continue;
      }
      const artifactPath = getArtifactPath(result.payload);
      if (artifactPath) {
        coveredPaths.add(artifactPath);
      }
    }

    const missingFiles = changedFiles.filter((file) => !coveredPaths.has(file));
    if (missingFiles.length > 0) {
      const preview = missingFiles.slice(0, 20).join(', ');
      core.error(`missing attestation for changed files (${missingFiles.length}): ${preview}`);
      core.setFailed('changed file coverage check failed');
      return;
    }
  }

  core.info(
    `BANSOU attestation verified (valid=${validResults.length}, ignored=${ignoredCount}, invalid=${invalidCount})`
  );
}

run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
