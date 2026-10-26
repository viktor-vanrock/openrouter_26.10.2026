import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'msw/node': fileURLToPath(new URL('./src/shared/api/msw-node-stub.ts', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['msw'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
