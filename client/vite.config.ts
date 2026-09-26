import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev: the Go server (server/, :8080) handles the WebSocket and event API.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/api': 'http://localhost:8080',
    },
  },
})
