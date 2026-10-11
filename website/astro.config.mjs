import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// https://astro.build/config
// Server-rendered output on the Node adapter. The canonical site origin
// comes from SITE_URL (e.g. SITE_URL=https://example.com bun run build);
// it is only used for metadata, never for routing.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  site: process.env.SITE_URL,
});
