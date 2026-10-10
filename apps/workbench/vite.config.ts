import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 4200,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
  },
  build: {
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\/](react|react-dom|scheduler)[\/]/,
            },
            {
              name: 'markdown',
              test: /node_modules[\/](react-markdown|remark-|rehype-|unified|micromark|mdast-|hast-|unist-|vfile|decode-named-character-reference)/,
            },
            {
              name: 'components',
              test: /node_modules[\/](radix-ui|@radix-ui|lucide-react|react-resizable-panels)/,
            },
          ],
        },
      },
    },
  },
});
