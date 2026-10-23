#!/usr/bin/env node
// Prova do "UM PAINEL POR VEZ" no celular.
//
// Mede, em cada caso, o que está REALMENTE na tela:
//   - barra fina do placar (topo), gaveta do placar e sheet de detalhe: caixa,
//     visibilidade e altura em px;
//   - soma das alturas dos painéis visíveis (barra + painéis de baixo);
//   - faixa de mapa livre (nem barra, nem sheet por cima) em px e em % do palco;
//   - quantas feições de prisma de zona as camadas desenharam (barras visíveis);
//   - console do app (error/pageerror) sem o ruído do driver WebGL headless;
//   - no desktop, o painel lateral e o sheet (que não pode existir).
//
// Casos por viewport:
//   sem_selecao_fechada  /mapa?z=4            (gaveta recolhida)
//   sem_selecao_gaveta   /mapa?z=4 + toque    (gaveta puxada)
//   com_selecao_peek     /mapa?uf=CE&z=5.8    (sheet recolhido)
//   com_selecao_aberta   ... + toque no header
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/painel_unico.mjs --base http://127.0.0.1:8110 \
//       --out _provas --prefix painel_unico
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: '390x844', largura: 390, altura: 844 },
  { nome: '390x700', largura: 390, altura: 700 },
]

const CAMADAS_ZONA = [
  'zonas-prisma-lula',
  'zonas-prisma-flavio',
  'zonas-prisma-outros',
  'zonas-prisma-nao-apurado',
]

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8110', out: '_provas', prefix: 'painel_unico' }
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

// Mede a tela. Tudo vem de getBoundingClientRect/getComputedStyle.
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
      opacity: estilo.opacity,
      pointerEvents: estilo.pointerEvents,
      classe: el.className,
    }
  }
  const visivel = (c) =>
    !!c &&
    c.display !== 'none' &&
    c.visibility !== 'hidden' &&
    Number(c.opacity) > 0.01 &&
    c.h > 0 &&
    c.w > 0

  const texto = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null)

  const barra = document.querySelector('.placar-barra')
  const gaveta = document.querySelector('.placar-gaveta')
  const sheet = document.querySelector('.sheet-detalhe')
  const palco = document.querySelector('.map-stage')
  const cBarra = caixa(barra)
  const cGaveta = caixa(gaveta)
  const cSheet = caixa(sheet)
  const cPalco = caixa(palco)

  const paineis = []
  if (visivel(cBarra)) paineis.push({ nome: 'barra-placar', h: cBarra.h, y: cBarra.y })
  if (visivel(cGaveta)) paineis.push({ nome: 'gaveta-placar', h: cGaveta.h, y: cGaveta.y })
  if (visivel(cSheet)) paineis.push({ nome: 'sheet-detalhe', h: cSheet.h, y: cSheet.y })

  // Faixa livre de mapa: do fim da barra (topo) até o topo do painel de baixo
  // mais alto. Sem painel de baixo, vai até o fim do palco.
  const baseDeBaixo = paineis
    .filter((p) => p.nome !== 'barra-placar')
    .reduce((maior, p) => Math.max(maior, p.h), 0)
  const topoBarra = cBarra ? cBarra.y + cBarra.h : cPalco ? cPalco.y : 0
  const fimPalco = cPalco ? cPalco.y + cPalco.h : 0
  const livre = cPalco ? Math.round(fimPalco - baseDeBaixo - topoBarra) : null

  const mapa = window.__mapa
  const prismas = {}
  for (const camada of [
    'zonas-prisma-lula',
    'zonas-prisma-flavio',
    'zonas-prisma-outros',
    'zonas-prisma-nao-apurado',
  ]) {
    const chave = camada.replace('zonas-prisma-', '')
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

  const textoSheet = texto(sheet)
  const textoGaveta = texto(gaveta)

  return {
    url: window.location.pathname + window.location.search,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    barra: cBarra,
    gaveta: cGaveta,
    gavetaVisivel: visivel(cGaveta),
    gavetaResumo: texto(gaveta?.querySelector('.sheet-resumo') ?? gaveta),
    sheet: cSheet,
    sheetVisivel: visivel(cSheet),
    sheetClasse: sheet ? sheet.className : null,
    paineis,
    paineisSomaPx: paineis.reduce((soma, p) => soma + p.h, 0),
    paineisAa: paineis.map((p) => `${p.nome}=${p.h}px`).join(' + '),
    palco: cPalco,
    mapaLivrePx: livre,
    mapaLivrePct:
      livre != null && cPalco && cPalco.h
        ? Math.round((livre / cPalco.h) * 1000) / 10
        : null,
    mapaLivreDaTelaPct:
      livre != null && window.innerHeight
        ? Math.round((livre / window.innerHeight) * 1000) / 10
        : null,
    repetiuPlacarNacionalNoSheet:
      textoSheet != null && /placar nacional/i.test(textoSheet)
        ? textoSheet.match(/.{0,40}placar nacional.{0,40}/i)[0]
        : null,
    textoSheetInicio: textoSheet ? textoSheet.slice(0, 160) : null,
    textoGavetaInicio: textoGaveta ? textoGaveta.slice(0, 160) : null,
    prismas,
    prismasTotal: Object.values(prismas).reduce(
      (soma, n) => soma + (Number.isFinite(n) ? n : 0),
      0,
    ),
    zoom: mapa ? Number(mapa.getZoom().toFixed(2)) : null,
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
          if (mapa.getLayer(camada)) {
            total += mapa.queryRenderedFeatures({ layers: [camada] }).length
          }
        } catch {
          /* camada em transição */
        }
      }
      return total
    }, CAMADAS_ZONA)
    if (n > 0) return n
    await page.waitForTimeout(400)
  }
  return 0
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

function filtroConsole(linhas) {
  const deAmbiente = (t) =>
    /GL Driver Message|swiftshader|WebGL-0x|Automatic fallback to software|Failed to create WebGL|GPU stall/i.test(
      t,
    )
  return {
    total: linhas.length,
    errosDoApp: linhas.filter((l) => /^(error|pageerror):/.test(l) && !deAmbiente(l)),
    avisos: linhas.filter((l) => /^warning:/.test(l) && !deAmbiente(l)),
  }
}

async function abrir(page, base, consulta, zoom) {
  await page.goto(`${base}/mapa?${consulta}`, { waitUntil: 'load' })
  await esperarZonas(page)
  await page.waitForSelector('.placar-barra', { state: 'visible' })
  await page.evaluate((pitch) => {
    window.__mapa?.easeTo({ pitch, bearing: 0, duration: 0 })
  }, zoom?.pitch ?? 52)
  await page.waitForTimeout(1600)
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
    const caso = {}

    // ---- 1. sem seleção, gaveta recolhida -------------------------------
    await abrir(page, opcoes.base, 'z=4')
    caso.sem_selecao_fechada = await page.evaluate(MEDIR)
    await page.screenshot({
      path: path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_sem_selecao_fechada.png`),
    })

    // ---- 2. sem seleção, gaveta puxada ----------------------------------
    await page.click('.placar-gaveta .sheet-resumo')
    await page.waitForTimeout(800)
    caso.sem_selecao_gaveta = await page.evaluate(MEDIR)
    await page.screenshot({
      path: path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_sem_selecao_gaveta.png`),
    })
    // volta a fechar pela mesma alça
    await page.click('.placar-gaveta .sheet-resumo')
    await page.waitForTimeout(500)

    // ---- 3. com seleção (CE), sheet recolhido ---------------------------
    await abrir(page, opcoes.base, 'uf=CE&z=5.8')
    caso.com_selecao_peek = await page.evaluate(MEDIR)
    await page.screenshot({
      path: path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_com_selecao_peek.png`),
    })

    // ---- 4. com seleção, sheet expandido --------------------------------
    // Só existe alternância depois da mudança (build antigo já nasce aberto).
    if (await page.locator('.sheet-detalhe .sheet-header-toque').count()) {
      await page.click('.sheet-detalhe .sheet-header-toque')
      await page.waitForTimeout(800)
      caso.com_selecao_aberta = await page.evaluate(MEDIR)
      await page.screenshot({
        path: path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_com_selecao_aberta.png`),
      })
    } else {
      caso.com_selecao_aberta = null
    }

    relatorio.telas[vp.nome] = { ...caso, console: filtroConsole(consoleLinhas) }
    await contexto.close()
  }

  // ---- desktop: nada de sheet, painel lateral intacto -------------------
  const contextoDesk = await navegador.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  })
  const pageDesk = await contextoDesk.newPage()
  const consoleDesk = ligarConsole(pageDesk)
  const medirDesktop = () =>
    pageDesk.evaluate(() => {
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
          visibility: estilo.visibility,
        }
      }
      const painel = document.querySelector('.side-panel')
      return {
        url: window.location.pathname + window.location.search,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        palco: caixa('.map-stage'),
        painel: caixa('.side-panel'),
        placarNoPainel: !!painel?.querySelector('.scoreboard'),
        linhasDoPlacar: painel?.querySelectorAll('.score-row').length ?? 0,
        detalheCard: caixa('.side-panel .detail-card'),
        titulo: painel
          ?.querySelector('.detail-title')
          ?.textContent.replace(/\s+/g, ' ')
          .trim() ?? null,
        barraMobile: caixa('.placar-barra'),
        gavetaMobile: caixa('.placar-gaveta'),
        sheetMobile: caixa('.sheet-detalhe'),
        scrollLateral:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }
    })

  await pageDesk.goto(`${opcoes.base}/mapa?z=4.4`, { waitUntil: 'load' })
  await esperarZonas(pageDesk)
  await pageDesk.waitForTimeout(1600)
  const deskSemSelecao = await medirDesktop()
  await pageDesk.screenshot({
    path: path.join(opcoes.out, `${opcoes.prefix}_desktop_1440x900_sem_selecao.png`),
  })

  await pageDesk.goto(`${opcoes.base}/mapa?uf=CE&z=6.3`, { waitUntil: 'load' })
  await esperarZonas(pageDesk)
  await pageDesk.waitForTimeout(1600)
  const deskComSelecao = await medirDesktop()
  await pageDesk.screenshot({
    path: path.join(opcoes.out, `${opcoes.prefix}_desktop_1440x900_com_selecao.png`),
  })

  relatorio.telas.desktop = {
    sem_selecao: deskSemSelecao,
    com_selecao: deskComSelecao,
    console: filtroConsole(consoleDesk),
  }
  await contextoDesk.close()
  await navegador.close()

  const linha = (m) =>
    m
      ? {
          paineis: m.paineisAa,
          paineisSomaPx: m.paineisSomaPx,
          mapaLivrePx: m.mapaLivrePx,
          mapaLivrePct: m.mapaLivrePct,
          mapaLivreDaTelaPct: m.mapaLivreDaTelaPct,
          gavetaVisivel: m.gavetaVisivel,
          sheetVisivel: m.sheetVisivel,
          gavetaResumo: m.gavetaResumo,
          repetiuNoSheet: m.repetiuPlacarNacionalNoSheet,
          zonas: m.prismasTotal,
          zonasPorCamada: m.prismas,
        }
      : null

  relatorio.resumo = Object.fromEntries(
    Object.entries(relatorio.telas).map(([nome, tela]) => {
      if (tela.sem_selecao) {
        return [
          nome,
          {
            sem_selecao: {
              painel: tela.sem_selecao.painel,
              palco: tela.sem_selecao.palco,
              placarNoPainel: tela.sem_selecao.placarNoPainel,
              linhasDoPlacar: tela.sem_selecao.linhasDoPlacar,
              barraMobile: tela.sem_selecao.barraMobile,
              gavetaMobile: tela.sem_selecao.gavetaMobile,
              sheetMobile: tela.sem_selecao.sheetMobile,
              detalheCard: tela.sem_selecao.detalheCard,
              scrollLateral: tela.sem_selecao.scrollLateral,
            },
            com_selecao: {
              painel: tela.com_selecao.painel,
              palco: tela.com_selecao.palco,
              titulo: tela.com_selecao.titulo,
              placarNoPainel: tela.com_selecao.placarNoPainel,
              gavetaMobile: tela.com_selecao.gavetaMobile,
              sheetMobile: tela.com_selecao.sheetMobile,
              scrollLateral: tela.com_selecao.scrollLateral,
            },
            console: tela.console,
          },
        ]
      }
      return [
        nome,
        {
          sem_selecao_fechada: linha(tela.sem_selecao_fechada),
          sem_selecao_gaveta: linha(tela.sem_selecao_gaveta),
          com_selecao_peek: linha(tela.com_selecao_peek),
          com_selecao_aberta: tela.com_selecao_aberta
            ? linha(tela.com_selecao_aberta)
            : 'sem alternância neste build',
          console: tela.console,
        },
      ]
    }),
  )

  const arquivo = path.join(opcoes.out, `${opcoes.prefix}_relatorio.json`)
  await writeFile(arquivo, JSON.stringify(relatorio, null, 2), 'utf8')
  console.log(JSON.stringify(relatorio.resumo, null, 2))
  console.log(`relatorio: ${arquivo}`)
}

principal().catch((erro) => {
  console.error('ERRO NA PROVA:', erro)
  process.exit(1)
})
