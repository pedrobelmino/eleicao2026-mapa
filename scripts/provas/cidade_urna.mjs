#!/usr/bin/env node
// Prova do item 10 (CIDADE-URNA): prédios 3D por local de votação, urnas do
// local selecionado, fallback 2D e medidas de desempenho.
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/cidade_urna.mjs --base http://127.0.0.1:8100
//
// Mede, por cenário: tempo de render (setData dos prédios -> mapa ocioso, medido
// dentro do app em __mapaDebug.tempoRenderMs) e taxa de frames desenhando o 3D
// (repaint forçado por frame). Salva prints em _provas/ e o JSON das medidas.
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop', largura: 1440, altura: 900 },
  { nome: 'mobile', largura: 390, altura: 844 },
]

const CENARIOS = [
  {
    nome: 'fortaleza',
    uf: 'CE',
    municipio: '13897',
    zoom: '12.2',
    descricao: 'Fortaleza (196 locais) em prédios 3D',
  },
  {
    nome: 'sao_paulo',
    uf: 'SP',
    municipio: '71072',
    zoom: '12.2',
    descricao: 'São Paulo capital (161 locais / 26.683 seções)',
  },
]

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8100', out: '_provas', somente: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const [chave, naLinha] = argv[i].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = naLinha ?? argv[i + 1]
    if (naLinha == null) i += 1
  }
  opcoes.base = opcoes.base.replace(/\/+$/, '')
  return opcoes
}

// Frames por segundo desenhando o 3D de verdade: cada passo força um repaint do
// MapLibre e espera o quadro. Mede throughput de desenho, não o relógio do rAF.
async function medirFps(page, quadros = 60) {
  return page.evaluate(async (total) => {
    const mapa = window.__mapa
    if (!mapa) return null
    const inicio = performance.now()
    for (let indice = 0; indice < total; indice += 1) {
      mapa.triggerRepaint()
      await new Promise((resolver) => requestAnimationFrame(resolver))
    }
    const ms = performance.now() - inicio
    return {
      quadros: total,
      ms: Number(ms.toFixed(1)),
      fps: Number(((total / ms) * 1000).toFixed(1)),
    }
  }, quadros)
}

async function abrirCenario(browser, base, viewport, cenario, initScript) {
  const contexto = await browser.newContext({
    viewport: { width: viewport.largura, height: viewport.altura },
    deviceScaleFactor: 1,
  })
  const page = await contexto.newPage()
  if (initScript) await page.addInitScript(initScript)

  const erros = []
  const falhas = []
  page.on('console', (m) => {
    if (m.type() === 'error') erros.push(m.text())
  })
  page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => {
    const host = (() => {
      try {
        return new URL(r.url()).hostname
      } catch {
        return ''
      }
    })()
    const abortoTile =
      r.failure()?.errorText === 'net::ERR_ABORTED' &&
      (host === 'basemaps.cartocdn.com' ||
        host.endsWith('.basemaps.cartocdn.com'))
    if (!abortoTile) falhas.push(`${r.url()} (${r.failure()?.errorText})`)
  })
  page.on('response', (r) => {
    if (r.status() >= 400) falhas.push(`${r.status()} ${r.url()}`)
  })

  const url = `${base}/mapa?uf=${cenario.uf}&m=${cenario.municipio}&z=${cenario.zoom}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForSelector('canvas.maplibregl-canvas, canvas', { timeout: 30000 })

  // Espera os prédios existirem na fonte (ou o modo pontos, no cenário de
  // fallback) e o mapa assentar.
  await page.waitForFunction(
    () => {
      const d = window.__mapaDebug
      if (!d) return false
      if (window.__limitePredios) return Number(d.featuresLocaisPontos) > 0
      return Number(d.predios) > 0 || Number(d.prediosDesenhados) > 0
    },
    null,
    { timeout: 45000 },
  )
  await page.waitForTimeout(4000)
  await page.evaluate(
    () =>
      new Promise((resolver) => {
        const mapa = window.__mapa
        if (!mapa) return resolver(false)
        let pronto = false
        const fim = () => {
          if (pronto) return
          pronto = true
          resolver(true)
        }
        mapa.once('idle', fim)
        mapa.resize()
        mapa.triggerRepaint()
        setTimeout(fim, 8000)
      }),
  )
  await page.waitForTimeout(800)
  return { page, contexto, erros, falhas, url }
}

async function capturar(browser, base, out, viewport, cenario, initScript) {
  const rotulo = `[${cenario.nome}][${viewport.nome}]`
  const { page, contexto, erros, falhas, url } = await abrirCenario(
    browser,
    base,
    viewport,
    cenario,
    initScript,
  )
  const arquivo = path.join(
    out,
    `item10_${cenario.nome}_${viewport.nome}_${viewport.largura}x${viewport.altura}.png`,
  )

  const debug = await page.evaluate(() => window.__mapaDebug || null)
  const fps = await medirFps(page, 60)
  const tela = await page.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth ? 'SIM' : 'nao',
  )
  await page.screenshot({ path: arquivo })

  console.log(`${rotulo} url=${url}`)
  console.log(`${rotulo} print=${arquivo}`)
  console.log(`${rotulo} debug=${JSON.stringify(debug)}`)
  console.log(`${rotulo} fps=${JSON.stringify(fps)} scrollHorizontal=${tela}`)
  if (erros.length) console.log(`${rotulo} console.errors=${JSON.stringify(erros)}`)
  if (falhas.length) console.log(`${rotulo} requests.falhas=${JSON.stringify(falhas)}`)

  await page.close()
  await contexto.close()

  return { cenario: cenario.nome, viewport: viewport.nome, url, print: arquivo, debug, fps, erros, falhas, scrollHorizontal: tela }
}

// Clica num prédio desenhado e espera o cartão do local + as urnas na laje.
async function capturarUrnas(browser, base, out, viewport) {
  const cenario = { nome: 'urnas', uf: 'CE', municipio: '13897', zoom: '12.2' }
  const rotulo = `[urnas][${viewport.nome}]`
  const { page, contexto, erros, falhas } = await abrirCenario(
    browser,
    base,
    viewport,
    cenario,
  )

  const alvo = await page.evaluate(() => {
    const mapa = window.__mapa
    if (!mapa) return null
    let features = []
    try {
      features = mapa.queryRenderedFeatures({ layers: ['locais-prisma'] })
    } catch {
      return null
    }
    const mobile = window.innerWidth <= 820
    // No celular o bottom sheet cobre 72% da tela e engole o clique: o alvo
    // tem de estar na faixa visível de cima (mesma regra da captura do item 4).
    const yMaximo = mobile ? Math.round(window.innerHeight * 0.22) : window.innerHeight - 90
    let melhor = null
    for (const feature of features) {
      const anel = feature.geometry?.coordinates?.[0] || []
      if (anel.length < 4) continue
      let x = 0
      let y = 0
      for (const ponto of anel) {
        x += ponto[0]
        y += ponto[1]
      }
      const centro = [x / anel.length, y / anel.length]
      const tela = mapa.project(centro)
      if (tela.x < 40 || tela.x > window.innerWidth - 40) continue
      if (tela.y < 90 || tela.y > yMaximo) continue
      const vv = Number(feature.properties?.vv) || 0
      if (!melhor || vv > melhor.vv) {
        melhor = { x: Math.round(tela.x), y: Math.round(tela.y), vv, nr_local: feature.properties?.nr_local }
      }
    }
    return melhor
  })
  if (!alvo) throw new Error('nenhum prédio visível para clicar')

  const caixa = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.maplibregl-canvas')
    const r = canvas.getBoundingClientRect()
    return { x: r.x, y: r.y }
  })
  const px = Math.round(caixa.x + alvo.x)
  const py = Math.round(caixa.y + alvo.y)
  await page.mouse.click(px, py)
  // O cartão existe em DOIS lugares (painel lateral e bottom sheet). No celular
  // o painel lateral está com display:none, então o seletor tem de ser o do
  // bottom sheet — senão o waitForSelector pega o elemento invisível.
  const seletorCartao =
    viewport.largura <= 820 ? '.bottom-sheet .local-card' : '.side-panel .local-card'
  await page.waitForSelector(seletorCartao, { state: 'visible', timeout: 20000 })
  await page.waitForFunction(
    () => Number(window.__mapaDebug?.urnasDesenhadas || 0) > 0,
    null,
    { timeout: 20000 },
  )
  await page.waitForTimeout(2500)

  const debug = await page.evaluate(() => window.__mapaDebug || null)
  const fps = await medirFps(page, 60)
  const cartao = await page.evaluate((seletor) => {
    const el = document.querySelector(seletor)
    return {
      titulo: el?.querySelector('.detail-title')?.textContent || '',
      apurado: el?.querySelector('.local-apurado-numero')?.textContent || '',
      secoes: el?.querySelectorAll('.section-item').length || 0,
    }
  }, seletorCartao)
  const arquivo = path.join(
    out,
    `item10_urnas_${viewport.nome}_${viewport.largura}x${viewport.altura}.png`,
  )
  await page.screenshot({ path: arquivo })

  console.log(`${rotulo} clique=(${px},${py}) nr_local=${alvo.nr_local} vv=${alvo.vv}`)
  console.log(`${rotulo} print=${arquivo}`)
  console.log(`${rotulo} cartao=${JSON.stringify(cartao)}`)
  console.log(`${rotulo} debug=${JSON.stringify(debug)}`)
  console.log(`${rotulo} fps=${JSON.stringify(fps)}`)
  if (erros.length) console.log(`${rotulo} console.errors=${JSON.stringify(erros)}`)
  if (falhas.length) console.log(`${rotulo} requests.falhas=${JSON.stringify(falhas)}`)

  await page.close()
  await contexto.close()
  return { cenario: 'urnas', viewport: viewport.nome, print: arquivo, clique: { px, py, ...alvo }, cartao, debug, fps, erros, falhas }
}

async function principal() {
  const { base, out, somente } = lerArgumentos(process.argv.slice(2))
  const pedacos = String(somente || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const querTudo = pedacos.length === 0
  const quer = (nome) => querTudo || pedacos.includes(nome)
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

  const medidas = []
  let falhou = false
  try {
    for (const viewport of VIEWPORTS) {
      for (const cenario of CENARIOS) {
        if (!quer('cidade')) continue
        const medida = await capturar(browser, base, out, viewport, cenario)
        medidas.push(medida)
        if (medida.erros.length || medida.falhas.length) falhou = true
        if (medida.debug?.modoPredios !== 'predios') {
          console.log(`[${cenario.nome}][${viewport.nome}] FALHA=modoPredios=${medida.debug?.modoPredios}`)
          falhou = true
        }
      }
    }

    // Urnas do local selecionado (clique real num prédio).
    for (const viewport of VIEWPORTS) {
      if (!quer('urnas')) continue
      const medida = await capturarUrnas(browser, base, out, viewport)
      medidas.push(medida)
      if (medida.erros.length || medida.falhas.length) falhou = true
    }

    // Fallback: limite de prédios forçado para 20 -> modo pontos 2D.
    for (const viewport of VIEWPORTS) {
      if (!quer('fallback')) continue
      const medida = await capturar(
        browser,
        base,
        out,
        viewport,
        { ...CENARIOS[0], nome: 'fallback_2d', descricao: 'fallback 2D forçado' },
        () => {
          window.__limitePredios = 20
        },
      )
      medidas.push(medida)
      if (medida.erros.length || medida.falhas.length) falhou = true
      if (medida.debug?.modoPredios !== 'pontos' || Number(medida.debug?.prediosDesenhados) > 0) {
        console.log(`[fallback_2d][${viewport.nome}] FALHA=${JSON.stringify(medida.debug)}`)
        falhou = true
      }
    }
  } finally {
    await browser.close()
  }

  await writeFile(
    path.join(out, 'item10_metricas.json'),
    JSON.stringify(medidas, null, 2),
  )
  console.log(`\nmedidas salvas em ${path.join(out, 'item10_metricas.json')}`)
  if (falhou) {
    console.error('PROVA FALHOU: veja FALHA/console.errors/requests.falhas acima.')
    process.exitCode = 1
  } else {
    console.log('PROVA OK: prédios 3D, urnas e fallback 2D sem erro de console/request.')
  }
}

principal().catch((erro) => {
  console.error('PROVA FALHOU ao executar o Playwright:', erro)
  process.exitCode = 1
})
