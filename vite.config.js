import { defineConfig } from 'vite';
import react from '@vitejs/vite-plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/', // This forces GitHub Pages to read your files from findmypackage.tech/ instead of a broken subfolder
});
