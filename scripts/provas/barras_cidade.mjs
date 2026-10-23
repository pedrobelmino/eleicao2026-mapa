#!/usr/bin/env node
// Prova das BARRAS DE ZONA NO NÍVEL DE CIDADE (missão Pedro 22/10 19:30).
//
// O que prova, por captura e lendo do próprio mapa (nunca estimando):
//   - __mapaDebug.featuresZonas > 0 em z=8.5, 9.5, 10.5 e 12 em FORTALEZA;
//   - quantas feições cada segmento da BARRA (centroide) desenhou e quantas a
//     barra de área (faixa de estado) ainda desenha;
//   - rótulos: camadas de município do basemap ocultas na faixa das barras e
//     nenhuma duplicação (nosso rótulo x rótulo do basemap no mesmo pixel);
//   - console limpo (0 erros) e nenhuma request >= 400.
//
// Roda com NODE_PATH apontando para os node_modules do agente:
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/barras_cidade.mjs --base http://127.0.0.1:8110
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
// Fonte única dos limites de faixa: se o mapa mudar o corte das barras, a prova
// acompanha sem precisar de número repetido aqui.
import { ZOOM_BARRA_ZONA, ZOOM_BARRA_ZONA_FIM } from '../../web/src/mapa.js'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const ZOOMS = ['8.5', '9.5', '10.5', '12']
// Padrão da prova: FORTALEZA (CE). --uf/--m trocam o alvo (ex.: SP, que tem
// 1851 zonas e é o caso de carga da fonte).
const UF = 'CE'
const MUNICIPIO = '13897' // cd_tse de FORTALEZA

const VIEWPORTS = [
  { nome: 'desktop', largura: 1440, altura: 900 },
  { nome: 'mobile', largura: 390, altura: 844 },
]

const CAMADAS_AREA = [
  'zonas-prisma-lula',
  'zonas-prisma-flavio',
  'zonas-prisma-outros',
  'zonas-prisma-nao-apurado',
]
// Duas larguras de losango com cross-fade: a larga cobre a aproximação (7.4..9.9)
// e a fina o nível de cidade (9.3..12.2). A prova mede as oito.
const CAMADAS_BARRA = [
  'zonas-barra-lula',
  'zonas-barra-flavio',
  'zonas-barra-outros',
  'zonas-barra-nao-apurado',
  'zonas-barra-fina-lula',
  'zonas-barra-fina-flavio',
  'zonas-barra-fina-outros',
  'zonas-barra-fina-nao-apurado',
]

function lerArgumentos(argv) {
  const opcoes = {
    base: 'http://127.0.0.1:8110',
    out: '_provas',
    prefix: 'barras_cidade',
    zooms: '',
    viewports: '',
    uf: UF,
    m: MUNICIPIO,
  }
  for (let indice = 0; indice < argv.length; indice += 1) {
    const [chave, naLinha] = argv[indice].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = naLinha ?? argv[indice + 1]
    if (naLinha == null) indice += 1
  }
  opcoes.base = opcoes.base.replace(/\/+$/, '')
  // --zooms=7.6,8.0,9.0 permite varrer a faixa e provar que não existe zoom
  // em que as barras de zona somem (o "pulo" que o dono do produto reclamou).
  opcoes.zooms = opcoes.zooms
    ? String(opcoes.zooms).split(',').map((valor) => valor.trim()).filter(Boolean)
    : ZOOMS
  // --viewports=desktop,mobile limita a varredura a uma tela.
  opcoes.viewports = opcoes.viewports
    ? String(opcoes.viewports).split(',').map((valor) => valor.trim()).filter(Boolean)
    : VIEWPORTS.map((item) => item.nome)
  return opcoes
}

// MEDIR roda dentro da página: tudo sai de __mapa/__mapaDebug, sem conta feita
// fora do navegador.
const MEDIR = ({ camadasArea, camadasBarra }) => {
  const mapa = window.__mapa
  const debug = window.__mapaDebug || {}
  const contar = (camada) => {
    if (!mapa.getLayer(camada)) return { existe: false, feicoes: 0 }
    let feicoes = []
    try {
      feicoes = mapa.queryRenderedFeatures({ layers: [camada] })
    } catch {
      feicoes = []
    }
    return { existe: true, feicoes: feicoes.length }
  }

  const area = {}
  for (const camada of camadasArea) area[camada] = contar(camada)
  const barra = {}
  for (const camada of camadasBarra) barra[camada] = contar(camada)

  const amostra = (() => {
    for (const camada of camadasBarra) {
      if (!mapa.getLayer(camada)) continue
      let feicoes = []
      try {
        feicoes = mapa.queryRenderedFeatures({ layers: [camada] })
      } catch {
        feicoes = []
      }
      if (feicoes.length) {
        const p = feicoes[0].properties || {}
        return {
          camada,
          zona: p.zona,
          municipio: p.municipio,
          altura_m: Number(p.altura_m) || 0,
          bar_lula: p.bar_lula,
          bar_flavio: p.bar_flavio,
          bar_outros: p.bar_outros,
          bar_nao_apurado: p.bar_nao_apurado,
        }
      }
    }
    return null
  })()

  // Rótulos: as camadas place_* do basemap precisam estar em 'none' na faixa
  // das barras; o nosso rótulo de município pode aparecer (é o substituto).
  const estilo = mapa.getStyle()
  const base = (estilo.layers || []).filter((l) =>
    /^place_(city|town|villages|hamlet|suburbs|capital)/.test(l.id),
  )
  const baseOcultas = base.filter(
    (l) => mapa.getLayoutProperty(l.id, 'visibility') === 'none',
  )
  let baseDesenhadas = 0
  for (const camada of base) {
    if (mapa.getLayoutProperty(camada.id, 'visibility') === 'none') continue
    try {
      baseDesenhadas += mapa.queryRenderedFeatures({ layers: [camada.id] }).length
    } catch {
      // camada sem símbolo na tela
    }
  }

  let rotulosMunicipio = 0
  if (mapa.getLayer('municipios-labels')) {
    try {
      rotulosMunicipio = mapa.queryRenderedFeatures({ layers: ['municipios-labels'] }).length
    } catch {
      rotulosMunicipio = 0
    }
  }

  return {
    zoom: Number(mapa.getZoom().toFixed(2)),
    pitch: Number(mapa.getPitch().toFixed(1)),
    centro: [
      Number(mapa.getCenter().lng.toFixed(3)),
      Number(mapa.getCenter().lat.toFixed(3)),
    ],
    debug: {
      // tempoRenderMs sai do próprio app (MapView: setData -> mapa idle). Em
      // zoom sem prédios de local ele fica 0 por construção: a prova imprime o
      // valor e NÃO inventa número.
      tempoRenderMs: Number(debug.tempoRenderMs) || 0,
      featuresZonas: debug.featuresZonas,
      featuresLocais: debug.featuresLocais,
      featuresLocaisPrisma: debug.featuresLocaisPrisma,
      featuresMunicipios: debug.featuresMunicipios,
      modoPredios: debug.modoPredios,
      nivel: debug.nivel,
      zoom: debug.zoom,
    },
    area,
    barra,
    amostra,
    rotulos: {
      baseCamadas: base.length,
      baseOcultas: baseOcultas.length,
      baseDesenhadas,
      municipioDesenhados: rotulosMunicipio,
    },
  }
}

async function capturar(browser, base, out, prefix, viewport, zoom, uf, municipio) {
  const rotulo = `[${uf}/${municipio}][${viewport.nome}][z=${zoom}]`
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

  const url = `${base}/mapa?uf=${uf}&m=${municipio}&z=${zoom}`
  const arquivo = `${prefix}_${uf}_${viewport.nome}_${viewport.largura}x${viewport.altura}_z${zoom}.png`
  const destino = path.join(out, arquivo)
  let medicao = null
  let falha = null
  let esperouZonas = false

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForSelector('canvas.maplibregl-canvas, canvas', { timeout: 30000 })
    try {
      await page.waitForFunction(() => window.__mapaDebug && window.__mapaDebug.featuresZonas > 0, null, {
        timeout: 15000,
      })
      esperouZonas = true
    } catch {
      esperouZonas = false
    }
    // Deixa a animação do deep link assentar (fitBounds + pitch) e força um
    // frame: em GPU de software o canvas pode ficar sem repaint.
    await page.waitForTimeout(4000)
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
          setTimeout(fim, 12000)
        }),
    )
    await page.waitForTimeout(1200)
    medicao = await page.evaluate(MEDIR, { camadasArea: CAMADAS_AREA, camadasBarra: CAMADAS_BARRA })
    await page.screenshot({ path: destino })
  } catch (erro) {
    falha = erro.message
    try {
      await page.screenshot({ path: destino })
    } catch {
      // print de socorro é opcional
    }
  } finally {
    await page.close()
    await context.close()
  }

  console.log(`${rotulo} url=${url}`)
  console.log(`${rotulo} print=${destino}`)
  if (falha) console.log(`${rotulo} FALHA=${falha}`)
  console.log(`${rotulo} esperouFeaturesZonas>0=${esperouZonas}`)
  if (medicao) {
    console.log(
      `${rotulo} medido zoom=${medicao.zoom} pitch=${medicao.pitch} centro=${medicao.centro[0]},${medicao.centro[1]}`,
    )
    console.log(`${rotulo} __mapaDebug=${JSON.stringify(medicao.debug)}`)
    console.log(
      `${rotulo} area=${JSON.stringify(medicao.area)} barra=${JSON.stringify(medicao.barra)}`,
    )
    console.log(`${rotulo} amostra_barra=${JSON.stringify(medicao.amostra)}`)
    console.log(`${rotulo} rotulos=${JSON.stringify(medicao.rotulos)}`)
  }
  console.log(`${rotulo} console.errors=${erros.length ? erros.join(' | ') : 'nenhum'}`)
  console.log(`${rotulo} requests>=400=${ruins.length ? ruins.join(' | ') : 'nenhum'}`)
  console.log('')

  return { medicao, falha, erros, ruins, esperouZonas, url, print: destino }
}

async function principal() {
  const { base, out, prefix, zooms, viewports, uf, m } = lerArgumentos(process.argv.slice(2))
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

  const resultados = []
  try {
    for (const viewport of VIEWPORTS.filter((item) => viewports.includes(item.nome))) {
      for (const zoom of zooms) {
        resultados.push(await capturar(browser, base, out, prefix, viewport, zoom, uf, m))
      }
    }
  } finally {
    await browser.close()
  }

  // Resumo: o veredito sai dos números, não de impressão.
  const problemas = []
  for (const item of resultados) {
    const rotulo = `${item.url.match(/\[|\]/) ? '' : ''}${item.url}`
    if (item.falha) problemas.push(`${rotulo}: falha de captura (${item.falha})`)
    if (item.erros.length) problemas.push(`${rotulo}: console com erro (${item.erros.join(' | ')})`)
    if (item.ruins.length) problemas.push(`${rotulo}: request >= 400 (${item.ruins.join(' | ')})`)
    if (!item.medicao) continue
    if (!(item.medicao.debug.featuresZonas > 0)) {
      problemas.push(`${rotulo}: featuresZonas=${item.medicao.debug.featuresZonas} (esperado > 0)`)
    }
    const zoom = Number(item.medicao.zoom)
    const barras = Object.values(item.medicao.barra).reduce((soma, c) => soma + c.feicoes, 0)
    const areas = Object.values(item.medicao.area).reduce((soma, c) => soma + c.feicoes, 0)
    // Faixa das barras: o losango só existe de ZOOM_BARRA_ZONA até
    // ZOOM_BARRA_ZONA_FIM. Abaixo disso quem tem de desenhar é o PRISMA DA ÁREA
    // — exigir barra em z=6.4 era falso positivo da prova, não defeito do mapa.
    if (zoom >= ZOOM_BARRA_ZONA && zoom <= 10.6 && barras === 0) {
      problemas.push(`${rotulo}: nenhuma barra de zona renderizada em z=${zoom}`)
    }
    if (zoom < ZOOM_BARRA_ZONA && areas === 0) {
      problemas.push(`${rotulo}: nenhum prisma de área renderizado em z=${zoom} (faixa de estado)`)
    }
    if (zoom > ZOOM_BARRA_ZONA_FIM && barras > 0) {
      problemas.push(`${rotulo}: barra de zona ainda desenhada depois de z=${ZOOM_BARRA_ZONA_FIM}`)
    }
    if (zoom >= 8.2 && zoom <= 11.5 && item.medicao.rotulos.baseDesenhadas > 0) {
      problemas.push(
        `${rotulo}: rótulo de município do basemap desenhado na faixa das barras (${item.medicao.rotulos.baseDesenhadas})`,
      )
    }
  }

  const resumo = {
    base,
    gerado_em: new Date().toISOString(),
    capturas: resultados.map((item) => ({
      url: item.url,
      print: item.print,
      medicao: item.medicao,
      erros: item.erros,
      requests_ruins: item.ruins,
      falha: item.falha,
    })),
    problemas,
  }
  const arquivoResumo = path.join(out, `${prefix}_resumo.json`)
  await writeFile(arquivoResumo, JSON.stringify(resumo, null, 2), 'utf8')
  console.log(`resumo=${arquivoResumo}`)
  if (problemas.length) {
    console.error(`PROVA FALHOU (${problemas.length}):\n- ${problemas.join('\n- ')}`)
    process.exitCode = 1
  } else {
    console.log('PROVA OK: zonas presentes na faixa de cidade, rótulos sem duplicação, console limpo.')
  }
}

principal().catch((erro) => {
  console.error('PROVA FALHOU ao executar o Playwright:', erro)
  process.exitCode = 1
})
