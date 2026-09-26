import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev: the Go server (server/, :8080) handles the WebSocket and event API.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // the 3D engine changes rarely: its own long-cached chunk, so app updates stay small
        manualChunks(id) {
          if (/node_modules\/(three|@react-three|postprocessing|n8ao)/.test(id)) return 'engine'
          // the voice guide's SDK (and what it brings) loads only when someone opens it
          // (VoiceCard.tsx): left to the default split, so it stays out of vendor
          if (/node_modules\/(@elevenlabs|livekit-client|@livekit|events|jose|loglevel|machina|sdp-transform|sdp|typed-emitter|webrtc-adapter|tslib)\//.test(id)) return
          if (id.includes('node_modules')) return 'vendor'
        },
      },
    },
  },
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/api': 'http://localhost:8080',
    },
  },
})
