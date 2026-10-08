import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/prompts', { recursive: true });
cpSync('src/prompts', 'dist/prompts', {
  recursive: true,
  filter: (path) => !path.endsWith('.ts'),
});
cpSync('src/data', 'dist/data', { recursive: true });
