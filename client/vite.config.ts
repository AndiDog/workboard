import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [preact()],

  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },

  server: {
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Content-Security-Policy':
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com" +
        "; img-src 'self' https://avatars.githubusercontent.com/" +
        '; font-src https://fonts.gstatic.com',
    },
    port: 5174, // another of my projects already uses 5173 for local development
  },
});
