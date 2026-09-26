import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The files each next page needs (its chunk, the chunks it imports, its CSS), written into
// index.html so the landing can prefetch /play or /avatar once someone's clearly headed there.
function routeFiles(): Plugin {
  const pages: Record<string, string> = { '/play': '/src/App.tsx', '/avatar': '/src/AvatarStudio.tsx' }
  return {
    name: 'route-files',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle
        if (!bundle) return html
        const chunks = Object.values(bundle).filter((c) => c.type === 'chunk')
        const byName = new Map(chunks.map((c) => [c.fileName, c]))
        const routes: Record<string, string[]> = {}
        for (const [route, src] of Object.entries(pages)) {
          const entry = chunks.find((c) => c.facadeModuleId?.endsWith(src))
          if (!entry) continue
          const out = new Set<string>()
          const walk = (name: string) => {
            const c = byName.get(name)
            if (!c || out.has('/' + name)) return
            out.add('/' + name)
            c.viteMetadata?.importedCss.forEach((css) => out.add('/' + css))
            c.imports.forEach(walk)
          }
          walk(entry.fileName)
          routes[route] = [...out]
        }
        return html.replace('</head>', `  <script>window.__routeFiles=${JSON.stringify(routes)}</script>\n  </head>`)
      },
    },
  }
}

// Dev: the Go server (server/, :8080) handles the WebSocket and event API.
export default defineConfig({
  plugins: [react(), routeFiles()],
  build: {
    rollupOptions: {
      output: {
        // Libraries change rarely: their own long-cached chunks, so app updates stay small.
        // Split so each page pulls only what it draws: React alone for the text pages, three +
        // fiber for every 3D page, and the post-processing stack (the heaviest part) only for
        // the game. drei and the rest are left to the bundler, which puts each helper next to
        // the pages that use it.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
          if (/node_modules\/(three|@react-three\/fiber|react-reconciler|its-fine|zustand|suspend-react|react-use-measure|use-sync-external-store)\//.test(id)) return 'engine'
          if (/node_modules\/(postprocessing|@react-three\/postprocessing|n8ao)\//.test(id)) return 'postfx'
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
