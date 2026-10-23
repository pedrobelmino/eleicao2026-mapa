#!/usr/bin/env node
// Instantâneo do /mapa SEM atalhos de URL (?uf/?z/?m), para comparar antes x depois
// da reestruturação de rotas em três níveis. Não toca em nada do mapa: só abre,
// espera as camadas assentarem e imprime. Serve para provar que o terceiro nível
// continua igual (mesmas camadas, mesmos contadores, mesmo quadro).
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/mapa_estado.mjs --base http://127.0.0.1:8100 \
//     --out _provas --prefix mapa_antes
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop', largura: 1440, altura: 900 },
  { nome: 'mobile', largura: 390, altura: 844 },
]

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8100', out: '_provas', prefix: 'mapa_estado' }
  for (let indice = 0; indice < argv.length; indice += 1) {
    const argumento = argv[indice]
    const [chave, valorNaMesmaLinha] = argumento.split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = valorNaMesmaLinha ?? argv[indice + 1]
    if (valorNaMesmaLinha == null) indice += 1
  }
  opcoes.base = opcoes.base.replace(/\/+$/, '')
  return opcoes
}

async function assentarMapa(page) {
  await page.waitForSelector('canvas.maplibregl-canvas, canvas', { timeout: 25000 })
  await page.waitForFunction(
    () =>
      Boolean(window.__mapaDebug) &&
      Number(window.__mapaDebug.featuresUfs || 0) > 0,
    null,
    { timeout: 30000 },
  )
  await page.waitForTimeout(3000)
  await page.evaluate(
    () =>
      new Promise((resolver) => {
        const mapa = window.__mapa
        if (!mapa) {
          resolver(false)
          return
        }
        let concluido = false
        const fim = () => {
          if (concluido) return
          concluido = true
          resolver(true)
        }
        mapa.once('idle', fim)
        mapa.resize()
        mapa.triggerRepaint()
        setTimeout(fim, 6000)
      }),
  )
  await page.waitForTimeout(1200)
}

async function capturar(browser, base, out, prefix, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.largura, height: viewport.altura },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  const errosConsole = []
  const requisicoesComErro = []
  page.on('console', (m) => {
    if (m.type() === 'error') errosConsole.push(m.text())
  })
  page.on('pageerror', (e) => errosConsole.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400) requisicoesComErro.push(`${r.status()} ${r.url()}`)
  })

  const arquivo = `${prefix}_${viewport.nome}_${viewport.largura}x${viewport.altura}.png`
  const destino = path.join(out, arquivo)
  let debug = null
  let camadas = null

  await page.goto(`${base}/mapa`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await assentarMapa(page)
  debug = await page.evaluate(() => window.__mapaDebug || null)
  camadas = await page.evaluate(() => {
    const mapa = window.__mapa
    if (!mapa) return null
    try {
      return {
        camadas: mapa.getStyle().layers.map((l) => l.id).sort(),
        fontes: Object.keys(mapa.getStyle().sources).sort(),
        zoom: mapa.getZoom(),
        centro: mapa.getCenter().toArray().map((n) => Number(n.toFixed(4))),
      }
    } catch (erro) {
      return { erro: String(erro) }
    }
  })
  await page.screenshot({ path: destino })

  console.log(`[mapa][${viewport.nome}] url=${base}/mapa`)
  console.log(`[mapa][${viewport.nome}] print=${destino}`)
  console.log(`[mapa][${viewport.nome}] __mapaDebug=${debug ? JSON.stringify(debug) : 'null'}`)
  console.log(
    `[mapa][${viewport.nome}] camadas=${camadas?.camadas?.length ?? '—'} fontes=${camadas?.fontes?.length ?? '—'} zoom=${camadas?.zoom ?? '—'} centro=${JSON.stringify(camadas?.centro ?? null)}`,
  )
  console.log(`[mapa][${viewport.nome}] console.errors=${errosConsole.length}`)
  console.log(`[mapa][${viewport.nome}] requests>=400=${requisicoesComErro.length}`)
  for (const item of requisicoesComErro) console.log(`[mapa][${viewport.nome}]   - ${item}`)
  for (const item of errosConsole) console.log(`[mapa][${viewport.nome}]   ! ${item}`)

  await page.close()
  await context.close()

  return { destino, errosConsole, requisicoesComErro, debug, camadas }
}

async function principal() {
  const { base, out, prefix } = lerArgumentos(process.argv.slice(2))
  await mkdir(out, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })
  let problemas = 0
  try {
    for (const viewport of VIEWPORTS) {
      const r = await capturar(browser, base, out, prefix, viewport)
      problemas += r.errosConsole.length + r.requisicoesComErro.length
    }
  } finally {
    await browser.close()
  }
  console.log(problemas === 0 ? 'MAPA OK: console limpo, nenhum request >= 400.' : `MAPA COM PROBLEMA: ${problemas}`)
  if (problemas > 0) process.exitCode = 1
}

principal().catch((erro) => {
  console.error('FALHOU:', erro)
  process.exitCode = 1
})
