import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// fixtures/ lives next to web/, so let the dev server read the parent folder.
export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: ['..'] } },
})
