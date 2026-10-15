// Production build + ZIP for distribution (Chrome Web Store upload or sharing with the team).
// Output: release/gtm-qa-checker-<version>.zip
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const { version } = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
execFileSync(process.execPath, ['build.mjs', '--prod'], { stdio: 'inherit' });

const releaseDir = resolve('release');
const zip = resolve(releaseDir, `gtm-qa-checker-${version}.zip`);
mkdirSync(releaseDir, { recursive: true });
rmSync(zip, { force: true });
// bsdtar ships with Windows 10+ and macOS; -a picks the ZIP format from the extension.
// On Windows call it by full path: Git Bash puts GNU tar (no ZIP support) first on PATH.
const tar = process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\tar.exe` : 'tar';
execFileSync(tar, ['-a', '-c', '-f', zip, '-C', 'dist', '.'], { stdio: 'inherit' });

console.log(`✓ ${zip} (${Math.round(statSync(zip).size / 1024)} KB)`);
