import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assessScan, stagingContext } from '../scripts/check-image-scan.mjs';

const policy = JSON.parse(readFileSync(new URL('../scripts/staging-image-risk.json', import.meta.url)));
const context = {
  now: Date.parse(policy.approvedAt),
  staging: true,
  source: policy.runtimeSourceFingerprint,
  runtime: policy.runtimeBinaryFingerprints
};
const finding = {
  VulnerabilityID: policy.trivyIds[0], Severity: 'HIGH',
  PkgName: policy.binaryPackage, InstalledVersion: policy.packageVersion
};
const report = (findings, extra = {}) => ({
  SchemaVersion: 2, Results: [
    { Class: 'os-pkgs', Type: 'debian', Vulnerabilities: findings, ...extra },
    { Class: 'lang-pkgs', Type: 'node-pkg' }
  ]
});

test('a reviewed staging finding stays visible while its exact exception is active', () => {
  const result = assessScan(report([finding]), policy, context);
  assert.equal(result.vulnerabilities[0].accepted, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.exceptionExpiresAt, policy.expiresAt);
});

test('exception fails closed on expiry, source changes, different binaries and outside staging', () => {
  for (const patch of [{ now: Date.parse(policy.expiresAt) }, { source: 'changed' },
    { runtime: ['changed'] }, { staging: false }]) {
    assert.equal(assessScan(report([finding]), policy, { ...context, ...patch }).blockers.length, 1);
  }
});

test('an exact documentation review uses the same staging exception and expiry', () => {
  const source = policy.equivalentRuntimeReviews[0].sourceFingerprint;
  assert.equal(assessScan(report([finding]), policy, { ...context, source }).blockers.length, 0);
  assert.equal(assessScan(report([finding]), policy, {
    ...context, source, runtime: ['changed']
  }).blockers.length, 1);
  assert.equal(assessScan(report([finding]), policy, {
    ...context, source, now: Date.parse(policy.expiresAt)
  }).blockers.length, 1);
});

test('unlisted findings, critical severity, package changes and available fixes block', () => {
  for (const patch of [{ VulnerabilityID: 'CVE-0000-0000' }, { Severity: 'CRITICAL' },
    { InstalledVersion: 'changed' }, { PkgName: 'other' }, { FixedVersion: 'available' }]) {
    const result = assessScan(report([{ ...finding, ...patch }]), policy, context);
    assert.equal(result.blockers.length, 1);
  }
  assert.equal(assessScan(report([], { Secrets: [{}] }), policy, context).secretCount, 1);
  assert.throws(() => assessScan({ SchemaVersion: 2, Results: [] }, policy, context), /Missing/);
});

test('only repository PRs into staging or staging release runs use the exception', () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'rohnn-afk/Founders-Lens' };
  assert.equal(stagingContext({ ...env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'staging' }), true);
  assert.equal(stagingContext({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/staging' }), true);
  assert.equal(stagingContext({ ...env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }), false);
});
