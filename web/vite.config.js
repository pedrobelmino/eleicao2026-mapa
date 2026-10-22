import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// O app é publicado na raiz do domínio. Em produção o nginx faz o proxy de
// /api/ para o serviço Go (api:8080); no dev server o proxy abaixo cumpre o
// mesmo papel.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
})
