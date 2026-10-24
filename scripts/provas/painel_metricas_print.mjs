#!/usr/bin/env node
// Print do painel privado de métricas (127.0.0.1:8112), viewport 1440x900 —
// mesmo padrão das outras provas (Playwright/Chromium do agente).
//
// Rodar com NODE_PATH apontando para os node_modules do agente:
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/painel_metricas_print.mjs --out _provas/defesa/AAAAMMDD-HHMM \
//     [--prefix painel_metricas]
//
// O token é lido do .env em tempo de execução e NUNCA é impresso.
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const args = process.argv.slice(2)
const pega = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao
}
const raiz = path.resolve(new URL('../..', import.meta.url).pathname)
const saida = path.resolve(pega('out', path.join(raiz, '_provas', 'defesa')))
const prefixo = pega('prefix', 'painel_metricas')
const base = pega('base', 'http://127.0.0.1:8112')

// O painel de loopback abre SEM token (decisão de 24/10/2026): o print padrão é
// da URL sem credencial. Com --com-token o script usa METRICAS_TOKEN do .env,
// para provar que o caminho com token continua funcionando.
const comToken = args.includes('--com-token')
let token = ''
if (comToken) {
  const env = await readFile(path.join(raiz, '.env'), 'utf8').catch(() => '')
  token = (env.match(/^METRICAS_TOKEN=(.*)$/m)?.[1] || '').trim().replace(/^"|"$/g, '')
  if (!token) {
    console.error('METRICAS_TOKEN ausente em .env')
    process.exit(2)
  }
}

await mkdir(saida, { recursive: true })

const navegador = await chromium.launch()
const pagina = await navegador.newPage({ viewport: { width: 1440, height: 900 } })
const url = `${base}/api/interno/painel` + (token ? `?token=${encodeURIComponent(token)}` : '')
const resposta = await pagina.goto(url, { waitUntil: 'load', timeout: 20000 })
const status = resposta ? resposta.status() : 0

// Contagens medidas na própria página (viram o resumo .json da prova).
const medidas = await pagina.evaluate(() => ({
  svg: document.querySelectorAll('svg').length,
  barrasHumano: document.querySelectorAll('.barra-humano').length,
  barrasBot: document.querySelectorAll('.barra-bot').length,
  secoes: document.querySelectorAll('h2').length,
  scripts: document.querySelectorAll('script').length,
  titulo: document.title,
}))

const arquivo = path.join(saida, `${prefixo}_desktop_1440x900.png`)
await pagina.screenshot({ path: arquivo, fullPage: true })
await navegador.close()

console.log(JSON.stringify({ url_sem_token: `${base}/api/interno/painel`, status, arquivo, ...medidas }, null, 2))
