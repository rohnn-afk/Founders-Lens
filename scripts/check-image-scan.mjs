import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
const scan = JSON.parse(readFileSync(input, 'utf8'));
if (scan.SchemaVersion !== 2 || !Array.isArray(scan.Results) || !scan.Results.length) {
  throw new Error('Missing image scan results');
}
const vulnerabilities = scan.Results.flatMap(result => (result.Vulnerabilities ?? []).map(v => ({
  id: v.VulnerabilityID, severity: v.Severity, package: v.PkgName,
  installed: v.InstalledVersion, fixed: v.FixedVersion
})));
const secretCount = scan.Results.reduce((count, result) => count + (result.Secrets?.length ?? 0), 0);
writeFileSync(output, JSON.stringify({ vulnerabilities, secretCount }, null, 2));
const blockers = vulnerabilities.filter(v => v.severity === 'CRITICAL' || v.severity === 'HIGH');
console.log(`Image scan found ${blockers.length} high/critical findings and ${secretCount} secret matches. See the redacted report.`);
if (blockers.length || secretCount) process.exitCode = 1;
