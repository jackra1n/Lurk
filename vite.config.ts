import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { getLogger } from './src/lib/server/logger';
import tailwindcss from '@tailwindcss/vite';

const logger = getLogger('VitePlugin');

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit(),
    {
      name: "lurk-startup",
      configureServer(server) {
        server.ssrLoadModule("/src/hooks.server.ts").catch((err) => {
          logger.error({ err }, "Failed to trigger backend initialization");
        });
      },
    },
  ],
});
