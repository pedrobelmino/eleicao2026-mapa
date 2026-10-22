#!/usr/bin/env node
// Checagem de console numa URL qualquer (usada para provar o CSP em produção,
// atrás do Cloudflare, onde o beacon RUM é injetado no HTML real).
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/console.mjs --url https://eleicao2026.belmino.dev/mapa
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

function opcoes(argv) {
  const saida = { url: '', espera: '4000', largura: '1440', altura: '900' }
  for (let i = 0; i < argv.length; i += 1) {
    const [chave, mesmo] = argv[i].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in saida)) continue
    saida[nome] = mesmo ?? argv[i + 1]
    if (mesmo == null) i += 1
  }
  return saida
}

async function principal() {
  const { url, espera, largura, altura } = opcoes(process.argv.slice(2))
  if (!url) {
    console.error('uso: console.mjs --url <url> [--espera ms]')
    process.exitCode = 2
    return
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })
  const contexto = await browser.newContext({
    viewport: { width: Number(largura), height: Number(altura) },
  })
  const pagina = await contexto.newPage()

  const erros = []
  const avisos = []
  const comErro = []
  pagina.on('console', (msg) => {
    const texto = msg.text()
    if (msg.type() === 'error') erros.push(texto)
    else if (msg.type() === 'warning') avisos.push(texto)
  })
  pagina.on('pageerror', (erro) => erros.push(`pageerror: ${erro.message}`))
  pagina.on('response', (resposta) => {
    if (resposta.status() >= 400) comErro.push(`${resposta.status()} ${resposta.url()}`)
  })

  const resposta = await pagina.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  })
  console.log(`url=${url}`)
  console.log(`status=${resposta ? resposta.status() : 'sem resposta'}`)
  const csp = resposta ? (await resposta.allHeaders())['content-security-policy'] : ''
  console.log(`csp_script_src=${/script-src([^;]*)/.exec(csp || '')?.[1]?.trim() || '—'}`)
  await pagina.waitForTimeout(Number(espera))

  console.log(`console.errors=${erros.length}`)
  for (const item of erros) console.log(`  - ${item}`)
  console.log(`console.warnings=${avisos.length}`)
  for (const item of avisos) console.log(`  - ${item}`)
  console.log(`requests>=400=${comErro.length}`)
  for (const item of comErro) console.log(`  - ${item}`)

  await contexto.close()
  await browser.close()

  if (erros.length > 0 || comErro.length > 0) process.exitCode = 1
}

principal().catch((erro) => {
  console.error('FALHOU:', erro)
  process.exitCode = 1
})
