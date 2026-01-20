import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit(),
    {
      name: "lurk-startup",
      configureServer(server) {
        server.ssrLoadModule("/src/hooks.server.ts").catch((err) => {
          console.error(
            "[Vite Plugin] Failed to trigger backend initialization:",
            err,
          );
        });
      },
    },
  ],
});
