import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/prompts', { recursive: true });
cpSync('src/prompts', 'dist/prompts', {
  recursive: true,
  filter: (path) => !path.endsWith('.ts'),
});
