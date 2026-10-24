#!/usr/bin/env node
// Print do painel de monitoramento (*.belmino.dev) — viewport 1440x900, mesmo
// padrão das outras provas (Playwright/Chromium do agente).
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/monitor_print.mjs --out _provas/monitoramento/AAAAMMDD-HHMM
//
// Gera:
//   painel_monitor.png        — janela 1 h, ao vivo
//   painel_monitor_5m.png     — janela 5 min (ataques)
//   painel_monitor_pausado.png— com o ao vivo pausado (prova do botão)
//   painel_monitor_log.json   — o estado que estava na tela no momento do print
import { mkdir, writeFile } from 'node:fs/promises'
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
const saida = path.resolve(pega('out', path.join(raiz, '_provas', 'monitoramento')))
const base = pega('base', 'http://192.168.5.179:8113')

await mkdir(saida, { recursive: true })

const navegador = await chromium.launch()
const pagina = await navegador.newPage({ viewport: { width: 1440, height: 900 } })

const erros = []
pagina.on('console', (msg) => { if (msg.type() === 'error') erros.push(msg.text()) })
pagina.on('pageerror', (erro) => erros.push(String(erro)))

await pagina.goto(base, { waitUntil: 'networkidle' })
// espera o primeiro retrato chegar (SSE ou polling)
await pagina.waitForFunction(
  () => document.querySelectorAll('#cards .card').length > 0,
  { timeout: 15000 },
)
await pagina.waitForTimeout(2500)

const selo = await pagina.textContent('#vivo-texto')
const cards = await pagina.$$eval('#cards .card', (nos) =>
  nos.map((n) => n.innerText.replace(/\n/g, ' ')))
const insights = await pagina.$$eval('#insights li', (nos) => nos.map((n) => n.innerText))
const ataques = await pagina.$$eval('#tabela-ataques tbody tr', (nos) =>
  nos.map((n) => n.innerText.replace(/\t/g, ' | ')))
const hosts = await pagina.$$eval('#tabela-hosts tbody tr', (nos) =>
  nos.map((n) => n.innerText.replace(/\t/g, ' | ')))

await pagina.screenshot({ path: path.join(saida, 'painel_monitor.png') })

// janela de 5 min: os ataques disparados pela prova
await pagina.click('button[data-janela="5m"]')
await pagina.waitForTimeout(1200)
await pagina.screenshot({ path: path.join(saida, 'painel_monitor_5m.png') })
const ataques5m = await pagina.$$eval('#tabela-ataques tbody tr', (nos) =>
  nos.map((n) => n.innerText.replace(/\t/g, ' | ')))

// pausar o ao vivo
await pagina.click('#pausar')
await pagina.waitForTimeout(1600)
const seloPausado = await pagina.textContent('#vivo-texto')
await pagina.screenshot({ path: path.join(saida, 'painel_monitor_pausado.png') })

// estado em disco: o mesmo do retrato, para conferência junto com os prints
const retrato = await pagina.evaluate(async () => {
  const resposta = await fetch('/api/monitor/estado', { cache: 'no-store' })
  return resposta.json()
})
await writeFile(path.join(saida, 'painel_monitor_log.json'), JSON.stringify(retrato, null, 1))

await navegador.close()

console.log('selo ao vivo :', selo)
console.log('selo pausado :', seloPausado)
console.log('cards        :', cards.join(' || '))
console.log('insights     :', insights.join(' || '))
console.log('ataques 1h   :', ataques.length, 'linha(s)')
console.log('hosts        :', hosts.join(' || '))
console.log('ataques 5m   :', ataques5m.join(' || '))
console.log('erros JS     :', erros.length ? erros.join(' | ') : 'nenhum')
console.log('prints em    :', saida)
