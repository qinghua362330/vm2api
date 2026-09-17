import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 部署前缀：挂在子路径下（反代 /vm2api/ → 本机）时，产物里的资源与 API 都要带上它。
// Vite 把 base 注入 import.meta.env.BASE_URL，session.ts 的 apiBase() 复用它。
const basePath = (() => {
  const raw = String(process.env.VITE_BASE_PATH || '').trim()
  if (!raw || raw === '/') return '/'
  return `${raw.startsWith('/') ? raw : `/${raw}`}`.replace(/\/+$/, '') + '/'
})()

export default defineConfig({
  base: basePath,
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.VM2API_API_PROXY || process.env.KIN_API_PROXY || 'http://127.0.0.1:8787',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
