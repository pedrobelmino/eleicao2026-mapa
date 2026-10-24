#!/usr/bin/env node
// Prova do BOTTOM-SHEET DE DETALHE no celular: PEEK por padrão, expandir só por
// toque/arraste. Mede o que está na tela (nada estimado):
//   - classe do sheet (is-peek / is-open) e altura em px;
//   - altura do .map-stage e a faixa de mapa VISÍVEL (não coberta pelo sheet);
//   - quantas feições de prisma de zona cada camada desenhou (colunas de zona);
//   - console (error/pageerror) filtrando o ruído do driver WebGL headless.
//
// Roda com NODE_PATH apontando para os node_modules do agente:
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/sheet_peek.mjs --base http://127.0.0.1:8110 --out _provas
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: '390x844', largura: 390, altura: 844 },
  { nome: '390x700', largura: 390, altura: 700 },
]

const CAMADAS_ZONA = {
  lula: 'zonas-prisma-lula',
  flavio: 'zonas-prisma-flavio',
  outros: 'zonas-prisma-outros',
  nao_apurado: 'zonas-prisma-nao-apurado',
}

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8110', out: '_provas', prefix: 'sheet_peek' }
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

// Medições tiradas da página.
const MEDIR = () => {
  const caixa = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const estilo = getComputedStyle(el)
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      display: estilo.display,
      visibility: estilo.visibility,
      maxHeight: estilo.maxHeight,
    }
  }
  const mapa = window.__mapa
  const sheet = document.querySelector('.sheet-detalhe')
  const palco = document.querySelector('.map-stage')
  const gaveta = document.querySelector('.placar-gaveta')
  const barra = document.querySelector('.placar-barra')
  const rPalco = palco ? palco.getBoundingClientRect() : null
  const rSheet = sheet ? sheet.getBoundingClientRect() : null
  // Faixa do palco que NENHUM sheet cobre: do topo do palco até o topo do
  // sheet de detalhe (ele é o mais alto dos dois sheets no rodapé).
  const visivel = rPalco && rSheet ? Math.round(rSheet.top - rPalco.top) : null
  const prismas = {}
  for (const [chave, camada] of Object.entries({
    lula: 'zonas-prisma-lula',
    flavio: 'zonas-prisma-flavio',
    outros: 'zonas-prisma-outros',
    nao_apurado: 'zonas-prisma-nao-apurado',
  })) {
    try {
      if (!mapa || !mapa.getLayer(camada)) {
        prismas[chave] = null
        continue
      }
      prismas[chave] = mapa.queryRenderedFeatures({ layers: [camada] }).length
    } catch {
      prismas[chave] = -1
    }
  }
  const texto = (sel) => {
    const el = sheet?.querySelector(sel)
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null
  }
  return {
    url: window.location.pathname + window.location.search,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    barra: caixa(barra),
    gaveta: { ...caixa(gaveta), classe: gaveta ? gaveta.className : null },
    sheet: caixa(sheet),
    sheetClasse: sheet ? sheet.className : null,
    sheetToque: caixa(sheet?.querySelector('.sheet-header-toque')),
    sheetChevron: caixa(sheet?.querySelector('.sheet-header-toque .sheet-header-chevron')),
    sheetCorpo: caixa(sheet?.querySelector('.sheet-body')),
    peekKicker: texto('.sheet-header-kicker'),
    peekTitulo: texto('.sheet-header-titulo'),
    peekLider: texto('.sheet-header-lider'),
    palco: caixa(palco),
    mapaVisivelPx: visivel,
    mapaVisivelPct:
      visivel != null && rPalco && rPalco.height
        ? Math.round((visivel / rPalco.height) * 1000) / 10
        : null,
    prisasDeZona: prismas,
    prisasTotal: Object.values(prismas).reduce(
      (soma, n) => soma + (Number.isFinite(n) ? n : 0),
      0,
    ),
    zoom: mapa ? Number(mapa.getZoom().toFixed(2)) : null,
    pitch: mapa ? Number(mapa.getPitch().toFixed(1)) : null,
  }
}

async function esperarZonas(page) {
  const prazo = Date.now() + 15000
  while (Date.now() < prazo) {
    const n = await page.evaluate((camadas) => {
      const mapa = window.__mapa
      if (!mapa) return 0
      let total = 0
      for (const camada of camadas) {
        try {
          if (!mapa.getLayer(camada)) continue
          total += mapa.queryRenderedFeatures({ layers: [camada] }).length
        } catch {
          /* camada em transição */
        }
      }
      return total
    }, Object.values(CAMADAS_ZONA))
    if (n > 0) return n
    await page.waitForTimeout(400)
  }
  return 0
}

function filtroConsole(linhas) {
  const deAmbiente = (t) =>
    /GL Driver Message|swiftshader|WebGL-0x|Automatic fallback to software/i.test(t)
  return {
    total: linhas.length,
    errosDoApp: linhas.filter((l) => /^(error|pageerror):/.test(l) && !deAmbiente(l)),
    avisos: linhas.filter((l) => /^warning:/.test(l) && !deAmbiente(l)),
  }
}

function ligarConsole(page) {
  const linhas = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      linhas.push(`${msg.type()}: ${msg.text()}`)
    }
  })
  page.on('pageerror', (erro) => linhas.push(`pageerror: ${erro.message}`))
  return linhas
}

async function abrirMapa(page, base, consulta) {
  await page.goto(`${base}/mapa?${consulta}`, { waitUntil: 'load' })
  const zonas = await esperarZonas(page)
  await page.waitForSelector('.placar-barra', { state: 'visible' })
  // Inclina mais (gesto de rotação do usuário), no nível de ZONA: é nele que a
  // coluna de 4 segmentos fica legível.
  await page.evaluate(() => {
    window.__mapa?.easeTo({ pitch: 52, bearing: 0, duration: 0 })
  })
  await page.waitForTimeout(1600)
  return zonas
}

async function principal() {
  const opcoes = lerArgumentos(process.argv.slice(2))
  await mkdir(opcoes.out, { recursive: true })

  const navegador = await chromium.launch({
    headless: true,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })

  const relatorio = { base: opcoes.base, quando: new Date().toISOString(), telas: {} }

  for (const vp of VIEWPORTS) {
    const contexto = await navegador.newContext({
      viewport: { width: vp.largura, height: vp.altura },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    })
    const page = await contexto.newPage()
    const consoleLinhas = ligarConsole(page)

    // ?uf=CE é também o teste de DEEP LINK: tem de abrir em PEEK.
    const zonasIniciais = await abrirMapa(page, opcoes.base, 'uf=CE&z=5.8')

    const peek = await page.evaluate(MEDIR)
    const arqPeek = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_peek.png`)
    await page.screenshot({ path: arqPeek })

    // Expande por TOQUE no cabeçalho.
    let abriuPorToque = false
    if (await page.locator('.sheet-detalhe .sheet-header-toque').count()) {
      await page.click('.sheet-detalhe .sheet-header-toque')
      abriuPorToque = true
    }
    await page.waitForTimeout(700)
    const aberto = await page.evaluate(MEDIR)
    const arqAberto = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_expandido.png`)
    await page.screenshot({ path: arqAberto })

    // Recolhe de novo pelo toque: prova que o chevron alterna.
    if (abriuPorToque) {
      await page.click('.sheet-detalhe .sheet-header-toque')
      await page.waitForTimeout(700)
    }
    const recolhido = await page.evaluate(MEDIR)
    const arqRecolhido = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_recolhido.png`)
    await page.screenshot({ path: arqRecolhido })

    // Arraste na alça (grip): 60 px para cima abre.
    let abriuPorArraste = false
    const alca = page.locator('.sheet-detalhe .sheet-grip')
    if (await alca.count()) {
      const caixaAlca = await alca.boundingBox()
      if (caixaAlca) {
        const x = caixaAlca.x + caixaAlca.width / 2
        const y = caixaAlca.y + caixaAlca.height / 2
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x, y - 60, { steps: 8 })
        await page.mouse.up()
        await page.waitForTimeout(700)
        abriuPorArraste = (await page.evaluate(MEDIR)).sheetClasse?.includes('is-open')
        await page.screenshot({
          path: path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_arraste.png`),
        })
      }
    }

    relatorio.telas[vp.nome] = {
      peek,
      aberto,
      recolhido,
      abriuPorToque,
      abriuPorArraste,
      zonasIniciais,
      console: filtroConsole(consoleLinhas),
      prints: [arqPeek, arqAberto, arqRecolhido],
    }
    await contexto.close()
  }

  // Deep link no segundo viewport já está coberto (uf=CE). Agora o desktop:
  // nada de sheet, painel lateral intacto.
  const contexto = await navegador.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  })
  const page = await contexto.newPage()
  const consoleLinhas = ligarConsole(page)
  await page.goto(`${opcoes.base}/mapa?uf=CE&z=6.3`, { waitUntil: 'load' })
  await esperarZonas(page)
  await page.waitForTimeout(1800)
  const medidaDesktop = await page.evaluate(() => {
    const caixa = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const estilo = getComputedStyle(el)
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        display: estilo.display,
      }
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      palco: caixa('.map-stage'),
      painel: caixa('.side-panel'),
      sheet: caixa('.sheet-detalhe'),
      detalheCard: caixa('.side-panel .detail-card'),
      titulo: document
        .querySelector('.side-panel .detail-title')
        ?.textContent.replace(/\s+/g, ' ')
        .trim(),
      scrollLateral:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  })
  const arqDesktop = path.join(opcoes.out, `${opcoes.prefix}_desktop_1440x900.png`)
  await page.screenshot({ path: arqDesktop })
  relatorio.telas.desktop = {
    medida: medidaDesktop,
    console: filtroConsole(consoleLinhas),
    prints: [arqDesktop],
  }
  await contexto.close()

  await navegador.close()

  relatorio.resumo = Object.fromEntries(
    Object.entries(relatorio.telas).map(([nome, tela]) => {
      if (tela.medida) {
        return [
          nome,
          {
            palco: tela.medida.palco,
            painel: tela.medida.painel,
            sheet: tela.medida.sheet,
            detalheCard: tela.medida.detalheCard,
            console: tela.console,
          },
        ]
      }
      const linha = (m) =>
        m
          ? {
              classe: (m.sheetClasse || '').replace('bottom-sheet sheet-detalhe mobile-only', '').trim(),
              sheetH: m.sheet?.h ?? null,
              sheetY: m.sheet?.y ?? null,
              mapaVisivelPx: m.mapaVisivelPx,
              mapaVisivelPct: m.mapaVisivelPct,
              palcoH: m.palco?.h ?? null,
              zonas: m.prisasTotal,
              zonasPorCamada: m.prisasDeZona,
              kicker: m.peekKicker,
              titulo: m.peekTitulo,
              lider: m.peekLider,
              chevron: m.sheetChevron ? `${m.sheetChevron.w}x${m.sheetChevron.h}` : null,
              corpoDisplay: m.sheetCorpo?.display ?? null,
            }
          : null
      return [
        nome,
        {
          peek: linha(tela.peek),
          expandido: linha(tela.aberto),
          recolhido: linha(tela.recolhido),
          abriuPorToque: tela.abriuPorToque,
          abriuPorArraste: tela.abriuPorArraste,
          console: tela.console,
        },
      ]
    }),
  )

  const arqRelatorio = path.join(opcoes.out, `${opcoes.prefix}_relatorio.json`)
  await writeFile(arqRelatorio, JSON.stringify(relatorio, null, 2), 'utf8')
  console.log(JSON.stringify(relatorio.resumo, null, 2))
  console.log(`relatorio: ${arqRelatorio}`)
}

principal().catch((erro) => {
  console.error('ERRO NA PROVA:', erro)
  process.exit(1)
})
