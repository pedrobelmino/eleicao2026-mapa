#!/usr/bin/env node
// Prova das BARRAS SEGMENTADAS da zona eleitoral (REGRA-BARRAS-ZONA.txt).
//
// Captura o zoom de estado (onde os prismas das zonas aparecem) em CE e SP,
// desktop e mobile, e devolve números lidos do próprio mapa (não estimados):
//   - quantas feições cada segmento desenhou (lula/flavio/outros/não apurado);
//   - base e altura em metros de UMA zona, calculadas pela mesma expressão do
//     estilo (fill-extrusion-base/height), para conferir o empilhamento.
//
// Roda com NODE_PATH apontando para os node_modules do agente:
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/barras_zona.mjs --base http://127.0.0.1:8100
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop', largura: 1440, altura: 900, zoom: '6.3' },
  { nome: 'mobile', largura: 390, altura: 844, zoom: '5.9' },
]

const UFS = ['CE', 'SP']

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8100', out: '_provas', prefix: 'barras_zona' }
  for (let indice = 0; indice < argv.length; indice += 1) {
    const [chave, naLinha] = argv[indice].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = naLinha ?? argv[indice + 1]
    if (naLinha == null) indice += 1
  }
  opcoes.base = opcoes.base.replace(/\/+$/, '')
  return opcoes
}

// Lê, dentro da página, o que cada segmento realmente desenhou e recalcula
// base/altura da zona com a MESMA aritmética do estilo (altura_m * bar/100,
// empilhada). É a prova numérica do print.
const MEDIR = () => {
  const mapa = window.__mapa
  const debug = window.__mapaDebug || {}
  const camadas = [
    'zonas-prisma-lula',
    'zonas-prisma-flavio',
    'zonas-prisma-outros',
    'zonas-prisma-nao-apurado',
  ]
  const porCamada = {}
  const amostras = {}
  for (const camada of camadas) {
    let feicoes = []
    try {
      feicoes = mapa.queryRenderedFeatures({ layers: [camada] })
    } catch {
      feicoes = []
    }
    porCamada[camada] = feicoes.length
    if (feicoes.length > 0) {
      const props = feicoes[0].properties
      const alturaM = Number(props.altura_m) || 0
      const bar = (nome) => (Number(props[nome]) || 0) / 100
      const lula = alturaM * bar('bar_lula')
      const flavio = alturaM * bar('bar_flavio')
      const outros = alturaM * bar('bar_outros')
      const naoApurado = alturaM * bar('bar_nao_apurado')
      amostras[camada] = {
        zona: props.zona,
        municipio: props.municipio,
        altura_m: alturaM,
        v13: props.v13,
        v22: props.v22,
        voutros: props.voutros,
        validos: props.validos,
        secoes_apuradas: props.secoes_apuradas,
        secoes_total: props.secoes_total,
        pct_apurado: props.pct_apurado,
        bar_lula: props.bar_lula,
        bar_flavio: props.bar_flavio,
        bar_outros: props.bar_outros,
        bar_nao_apurado: props.bar_nao_apurado,
        metros: {
          lula: [0, lula],
          flavio: [lula, lula + flavio],
          outros: [lula + flavio, lula + flavio + outros],
          nao_apurado: [lula + flavio + outros, alturaM],
        },
      }
    }
  }
  const estilo = mapa.getStyle().layers
    .filter((l) => camadas.includes(l.id))
    .map((l) => ({
      id: l.id,
      cor: l.paint?.['fill-extrusion-color'],
      base: JSON.stringify(l.paint?.['fill-extrusion-base']),
      altura: JSON.stringify(l.paint?.['fill-extrusion-height']),
    }))
  return {
    zoom: mapa.getZoom(),
    bearing: mapa.getBearing(),
    pitch: mapa.getPitch(),
    centro: mapa.getCenter(),
    debug,
    porCamada,
    amostras,
    estilo,
  }
}

async function capturar(browser, base, out, prefix, uf, viewport) {
  const rotulo = `[${uf}][${viewport.nome}]`
  const context = await browser.newContext({
    viewport: { width: viewport.largura, height: viewport.altura },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  const erros = []
  const ruins = []
  page.on('console', (m) => {
    if (m.type() === 'error') erros.push(m.text())
  })
  page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400) ruins.push(`${r.status()} ${r.url()}`)
  })

  const url = `${base}/mapa?uf=${uf}&z=${viewport.zoom}`
  const arquivo = `${prefix}_${uf}_${viewport.nome}_${viewport.largura}x${viewport.altura}.png`
  const destino = path.join(out, arquivo)
  let medicao = null
  let falha = null
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForSelector('canvas.maplibregl-canvas, canvas', { timeout: 30000 })
    await page.waitForFunction(
      () => window.__mapaDebug && window.__mapaDebug.featuresZonas > 0,
      null,
      { timeout: 30000 },
    )
    await page.waitForTimeout(3500)
    await page.evaluate(
      () =>
        new Promise((resolver) => {
          const mapa = window.__mapa
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
    await page.waitForTimeout(1500)
    medicao = await page.evaluate(MEDIR)
    await page.screenshot({ path: destino })
  } catch (erro) {
    falha = erro.message
    try {
      await page.screenshot({ path: destino })
    } catch {
      // captura de socorro é opcional
    }
  } finally {
    await page.close()
    await context.close()
  }

  console.log(`${rotulo} url=${url}`)
  console.log(`${rotulo} print=${destino}`)
  if (falha) {
    console.log(`${rotulo} FALHA=${falha}`)
  }
  if (medicao) {
    console.log(
      `${rotulo} zoom=${medicao.zoom.toFixed(3)} bearing=${medicao.bearing} pitch=${medicao.pitch} centro=${medicao.centro.lat.toFixed(3)},${medicao.centro.lng.toFixed(3)}`,
    )
    console.log(`${rotulo} feicoesPorSegmento=${JSON.stringify(medicao.porCamada)}`)
    const amostra = medicao.amostras['zonas-prisma-lula']
    if (amostra) {
      console.log(
        `${rotulo} ZONA ${amostra.zona} ${amostra.municipio}: v13=${amostra.v13} v22=${amostra.v22} voutros=${amostra.voutros} validos=${amostra.validos} secoes=${amostra.secoes_apuradas}/${amostra.secoes_total} pct=${amostra.pct_apurado}`,
      )
      console.log(
        `${rotulo} barras(%): lula=${amostra.bar_lula} flavio=${amostra.bar_flavio} outros=${amostra.bar_outros} nao_apurado=${amostra.bar_nao_apurado} soma=${
          (amostra.bar_lula + amostra.bar_flavio + amostra.bar_outros + amostra.bar_nao_apurado).toFixed(2)
        }`,
      )
      const m = amostra.metros
      console.log(
        `${rotulo} metros: lula=[${m.lula[0].toFixed(0)},${m.lula[1].toFixed(0)}] flavio=[${m.flavio[0].toFixed(0)},${m.flavio[1].toFixed(0)}] outros=[${m.outros[0].toFixed(0)},${m.outros[1].toFixed(0)}] nao_apurado=[${m.nao_apurado[0].toFixed(0)},${m.nao_apurado[1].toFixed(0)}] altura_m=${amostra.altura_m}`,
      )
    } else {
      console.log(`${rotulo} FALHA=nenhuma feicao do segmento lula renderizada`)
      falha = falha || 'segmento lula ausente'
    }
    for (const camada of Object.keys(medicao.porCamada)) {
      if (medicao.porCamada[camada] === 0 && camada !== 'zonas-prisma-nao-apurado') {
        falha = falha || `segmento vazio: ${camada}`
      }
    }
    console.log(`${rotulo} estilo=${JSON.stringify(medicao.estilo)}`)
  }
  console.log(`${rotulo} console.errors=${erros.length ? erros.join(' | ') : 'nenhum'}`)
  console.log(`${rotulo} requests>=400=${ruins.length ? ruins.join(' | ') : 'nenhum'}`)
  console.log('')

  return Boolean(falha) || erros.length > 0 || ruins.length > 0
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
  let falhou = false
  try {
    for (const viewport of VIEWPORTS) {
      for (const uf of UFS) {
        const ruim = await capturar(browser, base, out, prefix, uf, viewport)
        if (ruim) falhou = true
      }
    }
  } finally {
    await browser.close()
  }
  if (falhou) {
    console.error('PROVA FALHOU: ver as linhas FALHA/erros acima.')
    process.exitCode = 1
  } else {
    console.log('PROVA OK: os 3+ segmentos renderizaram em todas as capturas.')
  }
}

principal().catch((erro) => {
  console.error('PROVA FALHOU ao executar o Playwright:', erro)
  process.exitCode = 1
})
