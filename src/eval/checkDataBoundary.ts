import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../config.js';

/**
 * Confirms the data boundary holds BEFORE the first push, not after.
 *
 *   npm run check:data-boundary
 *
 * Snapshots contain other people's listing photos and descriptions: faces,
 * house interiors, enough detail to locate a seller. Once pushed, they are on
 * a third-party server whether or not the repo is private, and git history
 * makes that hard to undo. This check is cheap; the mistake is not.
 */

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
    if (/not a git repository/i.test(stderr)) {
      console.log('Not a git repository yet — nothing to check. Run this again after `git init`.');
      process.exit(0);
    }
    throw err;
  }
}

const failures: string[] = [];

// 1. Is data/listings actually ignored?
const ignored = git(['check-ignore', '-q', 'data/listings']) === '' ? true : true;
try {
  execFileSync('git', ['check-ignore', '-q', 'data/listings'], { cwd: REPO_ROOT });
} catch {
  failures.push(
    'data/listings/ is NOT gitignored. Snapshots would be committed. Check .gitignore.',
  );
}
void ignored;

// 2. Is anything under data/ tracked that shouldn't be?
const trackedData = git(['ls-files', 'data/']).split('\n').filter(Boolean);
const allowed = (f: string) =>
  f === 'data/manifest.json' || f.startsWith('data/labels/') || f.endsWith('.gitkeep');

const disallowed = trackedData.filter((f) => !allowed(f));
if (disallowed.length > 0) {
  failures.push(
    `${disallowed.length} file(s) under data/ are tracked but should not be:\n` +
      disallowed.slice(0, 20).map((f) => `    ${f}`).join('\n') +
      (disallowed.length > 20 ? `\n    ... and ${disallowed.length - 20} more` : ''),
  );
}

// 3. Any image files staged anywhere?
const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
const stagedImages = staged.filter((f) => /\.(jpe?g|png|webp|gif|heic)$/i.test(f));
if (stagedImages.length > 0) {
  failures.push(
    `Image files are staged for commit:\n` + stagedImages.map((f) => `    ${f}`).join('\n'),
  );
}

// 4. Any snapshot.json or page.html anywhere in history's index?
const trackedSnapshots = git(['ls-files'])
  .split('\n')
  .filter((f) => f.endsWith('snapshot.json') || f.endsWith('page.html'));
if (trackedSnapshots.length > 0) {
  failures.push(
    `Raw captures are tracked:\n` + trackedSnapshots.map((f) => `    ${f}`).join('\n'),
  );
}

console.log('Data boundary check\n');
console.log(`  tracked under data/: ${trackedData.length} file(s)`);
for (const f of trackedData.slice(0, 10)) console.log(`    ${f}`);
if (trackedData.length > 10) console.log(`    ... and ${trackedData.length - 10} more`);
console.log('');

if (failures.length === 0) {
  console.log('PASS — only the manifest and labels are tracked. Safe to push.');
  console.log('\nReminder: data/listings/ is irreplaceable and unbacked by design.');
  console.log('Listings vanish within days, so keep a Time Machine or external-drive backup.');
} else {
  console.error('FAIL\n');
  for (const f of failures) console.error(`  - ${f}\n`);
  console.error('Do not push until these are resolved.');
  process.exitCode = 1;
}
