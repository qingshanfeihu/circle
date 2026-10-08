import { activateRelease } from './install_layout.js';
const [root, prefix, binDir, repo] = process.argv.slice(2);
if (!root || !prefix || !binDir)
  throw new Error(
    'usage: install_manager <release-directory> <prefix> <bin-directory> [repository]',
  );
const manifest = activateRelease(root, prefix, binDir, repo);
process.stdout.write(`Installed circle ${manifest.version}\n`);
