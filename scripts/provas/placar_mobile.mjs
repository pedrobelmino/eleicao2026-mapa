#!/usr/bin/env node
// Prova do PLACAR MOBILE (barra fina no topo + gaveta do placar + legenda em chip).
//
// Roda com NODE_PATH apontando para os node_modules do agente:
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/placar_mobile.mjs --base http://127.0.0.1:8110 --out _provas
//
// Para cada viewport mobile (390x844 e 390x700) grava:
//   placar_mobile_<vp>_fechado.png   -> mapa com as torres de zona + barra fina
//   placar_mobile_<vp>_aberto.png    -> gaveta aberta
// e lê do DOM: altura da barra, o texto das duas linhas, se o scroll lateral
// existe (scrollWidth === clientWidth), altura do peek e da gaveta aberta.
// Desktop (1440x900) é capturado para comparar com o print anterior.
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8110', out: '_provas', prefix: 'placar_mobile' }
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

const MOBILE = [
  { nome: '390x844', largura: 390, altura: 844 },
  { nome: '390x700', largura: 390, altura: 700 },
]

// Medições tiradas da página (nada estimado).
const MEDIR = () => {
  const doc = document.documentElement
  const barra = document.querySelector('.placar-barra')
  const gaveta = document.querySelector('.placar-gaveta')
  const resumo = document.querySelector('.placar-gaveta .sheet-resumo')
  const chip = document.querySelector('.legend-toggle')
  const corpo = document.querySelector('.legend-corpo')
  const mapa = window.__mapa
  const camadas = {
    lula: 'zonas-prisma-lula',
    flavio: 'zonas-prisma-flavio',
    outros: 'zonas-prisma-outros',
    nao_apurado: 'zonas-prisma-nao-apurado',
  }
  const prismas = {}
  for (const [chave, camada] of Object.entries(camadas)) {
    let n = 0
    try {
      // Sem getLayer o MapLibre registra um console.error só porque a prova
      // perguntou por uma camada que ainda não existe — ruído da medição, não
      // do app.
      if (!mapa || !mapa.getLayer(camada)) {
        prismas[chave] = null
        continue
      }
      n = mapa.queryRenderedFeatures({ layers: [camada] }).length
    } catch {
      n = -1
    }
    prismas[chave] = n
  }
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
      fontSize: estilo.fontSize,
      zIndex: estilo.zIndex,
    }
  }
  const linhas = Array.from(document.querySelectorAll('.placar-barra-linha')).map(
    (linha) => {
      const texto = (sel) => linha.querySelector(sel)?.textContent?.trim() ?? ''
      return {
        texto: linha.textContent.replace(/\s+/g, ' ').trim(),
        partido: texto('.pb-partido'),
        nome: texto('.pb-nome'),
        pct: texto('.pb-pct'),
        votos: texto('.pb-votos'),
      }
    },
  )
  const atribuicao = document.querySelector('.maplibregl-ctrl-attrib')
  return {
    url: window.location.pathname + window.location.search,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scroll: {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      iguais: doc.scrollWidth === doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    },
    barra: caixa(barra),
    linhas,
    gaveta: caixa(gaveta),
    gavetaClasse: gaveta ? gaveta.className : null,
    resumo: caixa(resumo),
    chevron: caixa(document.querySelector('.placar-gaveta .sheet-resumo-chevron')),
    corpoGaveta: caixa(document.querySelector('.placar-gaveta .sheet-body')),
    metricas: Array.from(document.querySelectorAll('.gaveta-metrica')).map((m) =>
      m.textContent.replace(/\s+/g, ' ').trim(),
    ),
    chip: caixa(chip),
    chipRotulo: chip ? chip.textContent.replace(/\s+/g, ' ').trim() : null,
    corpoLegenda: caixa(corpo),
    atribuicao: caixa(atribuicao),
    prisasNaTela: prismas,
    zoom: mapa ? Number(mapa.getZoom().toFixed(2)) : null,
  }
}

async function esperarPrisas(page) {
  // O mapa monta o estilo no evento load; os prismas das zonas só entram
  // depois do detalhe da UF. Espera até 12 s por feição desenhada.
  const prazo = Date.now() + 12000
  while (Date.now() < prazo) {
    const n = await page.evaluate(() => {
      const mapa = window.__mapa
      if (!mapa || !mapa.getLayer('zonas-prisma-lula')) return 0
      try {
        return mapa.queryRenderedFeatures({ layers: ['zonas-prisma-lula'] }).length
      } catch {
        return 0
      }
    })
    if (n > 0) return n
    await page.waitForTimeout(400)
  }
  return 0
}

async function principal() {
  const opcoes = lerArgumentos(process.argv.slice(2))
  await mkdir(path.join(opcoes.out), { recursive: true })

  const navegador = await chromium.launch({
    headless: true,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })

  const relatorio = { base: opcoes.base, quando: new Date().toISOString(), telas: {} }

  for (const vp of MOBILE) {
    const contexto = await navegador.newContext({
      viewport: { width: vp.largura, height: vp.altura },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    })
    const page = await contexto.newPage()
    const consoleErros = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleErros.push(`${msg.type()}: ${msg.text()}`)
      }
    })
    page.on('pageerror', (erro) => consoleErros.push(`pageerror: ${erro.message}`))

    await page.goto(`${opcoes.base}/mapa?uf=SP&z=5.9`, { waitUntil: 'load' })
    const prismaAchado = await esperarPrisas(page)
    await page.waitForSelector('.placar-barra', { state: 'visible' })
    await page.waitForTimeout(1800)

    const fechado = await page.evaluate(MEDIR)
    const arqFechado = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_fechado.png`)
    const arqDetalhe = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_detalhe.png`)
    await page.screenshot({ path: arqDetalhe })

    // Torres de zona: o app já inclina a câmera (pitch 30) ao selecionar a UF;
    // aqui só se inclina mais — gesto de rotação do usuário — mantendo o zoom
    // no nível de ZONA (5.9): é nele que o prisma de 4 segmentos aparece com
    // altura legível. Em 7.6 o nível vira município e as torres ficam finas.
    await page.evaluate(() => {
      const mapa = window.__mapa
      if (!mapa) return
      mapa.easeTo({ pitch: 52, bearing: 0, duration: 0 })
    })
    await page.waitForTimeout(1400)
    const torres = await page.evaluate(MEDIR)
    const arqTorres = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_torres.png`)
    await page.screenshot({ path: arqTorres })

    // Fecha o sheet de detalhe (X) para deixar o mapa à mostra: é este estado
    // que prova as torres de zona + a barra fina no topo sem sheet por cima.
    if (await page.isVisible('.sheet-detalhe .sheet-close')) {
      await page.click('.sheet-detalhe .sheet-close')
      await page.waitForTimeout(900)
    }
    const comMapa = await page.evaluate(MEDIR)
    await page.screenshot({ path: arqFechado })

    // Abre a gaveta pelo resumo (o alvo de toque é o botão inteiro).
    await page.click('.placar-gaveta .sheet-resumo')
    await page.waitForTimeout(700)
    const aberto = await page.evaluate(MEDIR)
    const arqAberto = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_aberto.png`)
    await page.screenshot({ path: arqAberto })

    // Fecha de novo: prova que o chevron alterna e o peek volta.
    await page.click('.placar-gaveta .sheet-resumo')
    await page.waitForTimeout(600)
    const reFechado = await page.evaluate(MEDIR)
    const arqReFechado = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_refechado.png`)
    await page.screenshot({ path: arqReFechado })

    // Chip da legenda: recolhido por padrão, abre por toque.
    const chipVisivel = await page.isVisible('.legend-toggle')
    let legendaAberta = null
    if (chipVisivel) {
      await page.click('.legend-toggle')
      await page.waitForTimeout(500)
      legendaAberta = await page.evaluate(MEDIR)
      const arqLegenda = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_legenda.png`)
      await page.screenshot({ path: arqLegenda })
      await page.click('.legend-toggle')
    }

    relatorio.telas[vp.nome] = {
      fechado,
      comMapa,
      torres,
      aberto,
      reFechado,
      legendaAberta,
      prismaAchado,
      consoleErros,
      prints: [arqDetalhe, arqTorres, arqFechado, arqAberto, arqReFechado],
    }
    await contexto.close()
  }

  // Desktop: o mesmo recorte de antes, para comparar com os prints antigos.
  const contexto = await navegador.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  })
  const page = await contexto.newPage()
  const consoleErros = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErros.push(`${msg.type()}: ${msg.text()}`)
    }
  })
  page.on('pageerror', (erro) => consoleErros.push(`pageerror: ${erro.message}`))
  await page.goto(`${opcoes.base}/mapa?uf=SP&z=6.3`, { waitUntil: 'load' })
  await esperarPrisas(page)
  await page.waitForTimeout(1800)
  const desktop = await page.evaluate(MEDIR)
  const arqDesktop = path.join(opcoes.out, `${opcoes.prefix}_desktop_1440x900.png`)
  await page.screenshot({ path: arqDesktop })
  relatorio.telas.desktop = { medida: desktop, consoleErros, prints: [arqDesktop] }
  await contexto.close()

  await navegador.close()
  relatorio.resumo = Object.fromEntries(
    Object.entries(relatorio.telas).map(([nome, tela]) => {
      const m = tela.medida || tela.comMapa || tela.fechado
      const aberto = tela.aberto
      const linhasConsole = tela.consoleErros || []
      const deAmbiente = (texto) =>
        /GL Driver Message|swiftshader|WebGL-0x/i.test(texto)
      return [
        nome,
        {
          scrollLateral:
            m?.scroll && m.scroll.iguais === false
              ? `SIM (${m.scroll.scrollWidth} > ${m.scroll.clientWidth})`
              : 'nao',
          barra: m?.barra?.h ?? null,
          linhas: m?.linhas?.map((l) => l.texto) ?? [],
          peek: m?.gaveta?.h ?? null,
          aberta: aberto?.gaveta?.h ?? null,
          chevron: m?.chevron ? `${m.chevron.w}x${m.chevron.h}` : null,
          chip: m?.chip?.h ?? null,
          corpoLegendaVisivel: m?.corpoLegenda?.display !== 'none',
          atribuicaoY: m?.atribuicao?.y ?? null,
          // "erro do app" = error/pageerror que NAO é ruído do driver WebGL do
          // Chromium headless. warning é contado à parte.
          console: {
            total: linhasConsole.length,
            errosDoApp: linhasConsole.filter(
              (l) => /^(error|pageerror):/.test(l) && !deAmbiente(l),
            ),
            avisos: linhasConsole.filter((l) => /^warning:/.test(l)),
          },
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
