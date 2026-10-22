import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// O app é publicado em https://eleicao2026.belmino.dev/mapa/.
// Em produção o nginx faz o proxy de /mapa/api/ para o serviço Go (api:8080);
// no dev server o proxy abaixo cumpre o mesmo papel.
export default defineConfig({
  base: '/mapa/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/mapa/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mapa/, ''),
      },
    },
  },
})
