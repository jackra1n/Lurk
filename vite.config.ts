import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { getLogger } from './src/lib/server/logger.ts';
import tailwindcss from '@tailwindcss/vite';

const logger = getLogger('VitePlugin');

export default defineConfig({
  build: {
    // Preserve the Vite 7 browser baseline instead of adopting Vite 8's newer defaults.
    target: ['chrome107', 'edge107', 'firefox104', 'safari16']
  },
  plugins: [
    tailwindcss(),
    sveltekit(),
    {
      name: 'lurk-startup',
      configureServer(server) {
        server.ssrLoadModule('/src/hooks.server.ts').catch((err) => {
          logger.error({ err }, 'Failed to trigger backend initialization');
        });
      }
    }
  ]
});
