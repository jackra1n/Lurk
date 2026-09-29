import { execSync } from 'node:child_process';
import adapter from 'svelte-adapter-bun';
import pkg from './package.json' with { type: 'json' };

const readGitCommit = () => {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
};

const commit = (process.env.LURK_COMMIT || readGitCommit()).slice(0, 7);

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter(),
    version: {
      name: commit ? `${pkg.version}+${commit}` : pkg.version
    }
  }
};

export default config;
