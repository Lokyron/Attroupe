import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En développement, l'API tourne sur le serveur Node (port 3000) : on la fait suivre.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
});
