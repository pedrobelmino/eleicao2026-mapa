#!/usr/bin/env node
// Prova da EXPERIÊNCIA MOBILE do /mapa (decisão do Pedro, 24/10/2026):
//
//   1) aviso "Melhor experiência no desktop" — aparece só no celular, na
//      primeira visita, fecha no "Entendi" e não volta (localStorage);
//   2) mapa dominante — nada fixo cobrindo o mapa quando o painel está fechado;
//      a seleção NÃO abre painel nenhum (nem peek);
//   3) botão flutuante de mostrar/esconder detalhes — 56x56, aria-expanded
//      coerente, fecha sem limpar a seleção e sem mexer em zoom/viewport.
//
// Mede tudo no navegador real (playwright): geometria em px, área do palco
// coberta por painéis (união exata de retângulos, não estimativa), zoom e
// centro do MapLibre antes/depois, scrollWidth x clientWidth, console e
// requests >= 400. Prints em <out>/<prefix>_*.
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/mobile_ux.mjs --base http://127.0.0.1:8110 --out _provas
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: '390x844', largura: 390, altura: 844 },
  { nome: '390x700', largura: 390, altura: 700 },
]

const CD_TSE_FORTALEZA = 13897 // /api/uf/CE/municipios → FORTALEZA

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8110', out: '_provas', prefix: 'mobile_ux' }
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

// --------------------------------------------------------------- medições
const MEDIR = () => {
  const caixa = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      visivel:
        s.visibility === 'visible' && s.display !== 'none' && r.width > 0 && r.height > 0,
      opacidade: Number(s.opacity),
    }
  }
  const q = (sel) => document.querySelector(sel)
  const palco = q('.map-stage')
  const barra = q('.placar-barra')
  const gaveta = q('.placar-gaveta')
  const sheet = q('.sheet-detalhe')
  const botao = q('[data-prova="detalhe-toggle"]')
  const aviso = q('[data-prova="aviso-desktop"]')
  const mapa = window.__mapa

  const rPalco = palco ? palco.getBoundingClientRect() : null
  const corta = (r) => {
    if (!rPalco) return null
    const x1 = Math.max(r.x, rPalco.x)
    const y1 = Math.max(r.y, rPalco.y)
    const x2 = Math.min(r.x + r.width, rPalco.x + rPalco.width)
    const y2 = Math.min(r.y + r.height, rPalco.y + rPalco.height)
    if (x2 <= x1 || y2 <= y1) return null
    return { x1, y1, x2, y2 }
  }
  // União exata de retângulos (cortes em x e y): área coberta, sem estimativa.
  const uniao = (retangulos) => {
    const lista = retangulos.filter(Boolean)
    if (!lista.length) return 0
    const xs = [...new Set(lista.flatMap((r) => [r.x1, r.x2]))].sort((a, b) => a - b)
    const ys = [...new Set(lista.flatMap((r) => [r.y1, r.y2]))].sort((a, b) => a - b)
    let area = 0
    for (let i = 0; i < xs.length - 1; i += 1) {
      for (let j = 0; j < ys.length - 1; j += 1) {
        const cx = (xs[i] + xs[i + 1]) / 2
        const cy = (ys[j] + ys[j + 1]) / 2
        if (lista.some((r) => cx > r.x1 && cx < r.x2 && cy > r.y1 && cy < r.y2)) {
          area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j])
        }
      }
    }
    return area
  }
  const retangulosDe = (seletores) =>
    seletores
      .map((sel) => {
        const el = q(sel)
        if (!el) return null
        const c = caixa(el)
        if (!c || !c.visivel) return null
        return corta(el.getBoundingClientRect())
      })
      .filter(Boolean)

  const PAINEIS = [
    '.placar-barra',
    '.placar-gaveta',
    '.sheet-detalhe',
    '.aviso-desktop',
    '[data-prova="detalhe-toggle"]',
  ]
  const CHROME = [
    '.legend',
    '.modos-mapa',
    '.maplibregl-ctrl-top-right',
    '.maplibregl-ctrl-bottom-right',
    '.replay-bar',
  ]

  const areaPalco = rPalco ? rPalco.width * rPalco.height : 0
  const cobertoPaineis = uniao(retangulosDe(PAINEIS))
  const cobertoTotal = uniao(retangulosDe([...PAINEIS, ...CHROME]))

  // Faixa vertical livre: do topo do palco até o primeiro painel que ocupa
  // >= 80% da largura (barra do topo conta; chip de 44 px não).
  let faixa = rPalco ? rPalco.height : null
  if (rPalco) {
    let corte = rPalco.height
    for (const sel of ['.placar-barra', '.placar-gaveta', '.sheet-detalhe', '.aviso-desktop']) {
      const el = q(sel)
      if (!el) continue
      const c = caixa(el)
      if (!c || !c.visivel) continue
      if (c.w < rPalco.width * 0.8) continue
      const topo = c.y - rPalco.y
      const baixo = topo + c.h
      if (baixo > rPalco.height * 0.5) corte = Math.min(corte, topo) // painel de baixo
      else corte = Math.max(0, corte) // barra de topo: descontada abaixo
    }
    const barraCx = caixa(barra)
    const barraH = barraCx && barraCx.visivel ? barraCx.h : 0
    faixa = corte - barraH
  }

  return {
    url: window.location.pathname + window.location.search,
    vp: { w: window.innerWidth, h: window.innerHeight },
    scroll: {
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      iguais: document.documentElement.scrollWidth === document.documentElement.clientWidth,
    },
    palco: caixa(palco),
    barra: caixa(barra),
    gaveta: { ...caixa(gaveta), classe: gaveta ? gaveta.className : null },
    sheet: { ...caixa(sheet), classe: sheet ? sheet.className : null },
    sheetAriaHidden: sheet ? sheet.getAttribute('aria-hidden') : null,
    botao: botao ? { ...caixa(botao), rotulo: botao.getAttribute('aria-label'),
                     expandido: botao.getAttribute('aria-expanded') } : null,
    aviso: aviso
      ? {
          ...caixa(aviso),
          texto: aviso.textContent.replace(/\s+/g, ' ').trim(),
          temEntendi: Boolean(aviso.querySelector('[data-prova="aviso-entendi"]')),
        }
      : null,
    selecao: {
      temSelecao: document.querySelector('.workspace')?.classList.contains('tem-selecao'),
      tituloSheet: sheet?.querySelector('.sheet-header-titulo')?.textContent.trim() || null,
      siglaBotao: botao?.querySelector('.detalhe-toggle-sigla')?.textContent.trim() || null,
      detalheAtivo: window.__mapaDebug?.detalheAtivo ?? null,
      nivel: window.__mapaDebug?.nivel ?? null,
      featuresZonas: window.__mapaDebug?.featuresZonas ?? null,
      municipio: window.__mapaDebug?.municipioSelecionado ?? null,
    },
    zoom: mapa ? Number(mapa.getZoom().toFixed(4)) : null,
    centro: mapa
      ? [Number(mapa.getCenter().lng.toFixed(4)), Number(mapa.getCenter().lat.toFixed(4))]
      : null,
    pitch: mapa ? Number(mapa.getPitch().toFixed(1)) : null,
    areas: {
      palcoPx2: Math.round(areaPalco),
      cobertoPaineisPx2: Math.round(cobertoPaineis),
      cobertoTotalPx2: Math.round(cobertoTotal),
      livreDePaineisPct: areaPalco
        ? Math.round((1 - cobertoPaineis / areaPalco) * 1000) / 10
        : null,
      livreTotalPct: areaPalco ? Math.round((1 - cobertoTotal / areaPalco) * 1000) / 10 : null,
      faixaVisivelH: faixa == null ? null : Math.round(faixa),
      faixaVisivelPct:
        faixa == null || !rPalco || !rPalco.height
          ? null
          : Math.round((faixa / rPalco.height) * 1000) / 10,
    },
  }
}

function filtroConsole(linhas) {
  const ambiente = (t) =>
    /GL Driver Message|swiftshader|WebGL-0x|Automatic fallback to software/i.test(t)
  return {
    total: linhas.length,
    erros: linhas.filter((l) => /^(error|pageerror|http):/.test(l) && !ambiente(l)),
  }
}

function instrumentar(page, registro) {
  page.on('console', (m) => {
    if (m.type() === 'error') registro.console.push(`error: ${m.text()}`)
  })
  page.on('pageerror', (e) => registro.console.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400) registro.console.push(`http: ${r.status()} ${r.url()}`)
  })
}

async function assentar(page, url) {
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 30000 })
  await page.waitForFunction(
    () => Boolean(window.__mapa) && Number(window.__mapaDebug?.featuresUfs || 0) > 0,
    null,
    { timeout: 30000 },
  )
  await page.waitForTimeout(2500)
}

async function esperarZonas(page) {
  const prazo = Date.now() + 15000
  while (Date.now() < prazo) {
    const n = await page.evaluate(
      () => Number(window.__mapaDebug?.featuresZonas || 0),
    )
    if (n > 0) return n
    await page.waitForTimeout(400)
  }
  return 0
}

async function esperarDetalhe(page, cdTse) {
  const prazo = Date.now() + 20000
  while (Date.now() < prazo) {
    const ok = await page.evaluate(
      (cd) =>
        Boolean(window.__mapaDebug?.detalheAtivo) &&
        (window.__mapaDebug?.municipioSelecionado == null ||
          String(window.__mapaDebug?.municipioSelecionado?.cd_tse ?? '') === cd),
      String(cdTse ?? ''),
    )
    if (ok) return true
    await page.waitForTimeout(400)
  }
  return false
}

function achatar(m) {
  if (!m) return null
  return {
    palcoH: m.palco?.h ?? null,
    palcoW: m.palco?.w ?? null,
    barraH: m.barra?.h ?? null,
    gaveta: m.gaveta
      ? { w: m.gaveta.w, h: m.gaveta.h, visivel: m.gaveta.visivel,
          classe: m.gaveta.classe.replace('bottom-sheet placar-gaveta mobile-only', '').trim() }
      : null,
    sheet: m.sheet
      ? { y: m.sheet.y, w: m.sheet.w, h: m.sheet.h, visivel: m.sheet.visivel,
          classe: m.sheet.classe.replace('bottom-sheet sheet-detalhe mobile-only', '').trim(),
          ariaHidden: m.sheetAriaHidden }
      : null,
    botao: m.botao
      ? { w: m.botao.w, h: m.botao.h, x: m.botao.x, y: m.botao.y,
          rotulo: m.botao.rotulo, expandido: m.botao.expandido, visivel: m.botao.visivel }
      : null,
    aviso: m.aviso ? { w: m.aviso.w, h: m.aviso.h, y: m.aviso.y, visivel: m.aviso.visivel } : null,
    areas: m.areas,
    zoom: m.zoom,
    centro: m.centro,
    scroll: m.scroll,
    selecao: m.selecao,
  }
}

async function principal() {
  const opcoes = lerArgumentos(process.argv.slice(2))
  await mkdir(opcoes.out, { recursive: true })

  const navegador = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })

  const relatorio = { base: opcoes.base, quando: new Date().toISOString(), telas: {} }
  const falhas = []

  for (const vp of VIEWPORTS) {
    const registro = { console: [] }
    const contexto = await navegador.newContext({
      viewport: { width: vp.largura, height: vp.altura },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'pt-BR',
    })
    const page = await contexto.newPage()
    instrumentar(page, registro)
    const prints = []
    const tela = { prints }

    // ---------------------------------------------------- 1. aviso primeira visita
    await assentar(page, `${opcoes.base}/mapa?z=3.5`)
    await page.waitForTimeout(600)
    const comAviso = await page.evaluate(MEDIR)
    const arqAviso = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_macro_aviso.png`)
    await page.screenshot({ path: arqAviso })
    prints.push(arqAviso)

    const storageAntes = await page.evaluate(() =>
      window.localStorage.getItem('mapa.avisoDesktop'),
    )
    if (!comAviso.aviso || !comAviso.aviso.visivel) falhas.push(`${vp.nome}: aviso não apareceu`)
    if (comAviso.aviso && !comAviso.aviso.temEntendi) falhas.push(`${vp.nome}: aviso sem "Entendi"`)
    if (!/Melhor experiência no desktop/.test(comAviso.aviso?.texto || '')) {
      falhas.push(`${vp.nome}: texto do aviso não confere`)
    }
    if (storageAntes !== null) falhas.push(`${vp.nome}: localStorage já vinha setado`)

    await page.click('[data-prova="aviso-entendi"]')
    await page.waitForTimeout(500)
    const semAviso = await page.evaluate(MEDIR)
    const arqMacroFechado = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_macro_fechado.png`)
    await page.screenshot({ path: arqMacroFechado })
    prints.push(arqMacroFechado)
    const storageDepois = await page.evaluate(() =>
      window.localStorage.getItem('mapa.avisoDesktop'),
    )
    if (semAviso.aviso && semAviso.aviso.visivel) falhas.push(`${vp.nome}: aviso não fechou`)
    if (storageDepois !== '1') falhas.push(`${vp.nome}: dispensa não gravada (${storageDepois})`)

    // Reload: a dispensa persiste.
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('canvas.maplibregl-canvas')
    await page.waitForTimeout(2500)
    const aposReload = await page.evaluate(MEDIR)
    if (aposReload.aviso && aposReload.aviso.visivel) {
      falhas.push(`${vp.nome}: aviso voltou depois do reload`)
    }

    // ---------------------------------------------------- 2. nível ESTADO
    await assentar(page, `${opcoes.base}/mapa?uf=CE&z=5.8`)
    await page.evaluate(() => window.__mapa?.easeTo({ pitch: 52, bearing: 0, duration: 0 }))
    await esperarZonas(page)
    await esperarDetalhe(page, null)
    await page.waitForTimeout(1500)
    const estadoFechado = await page.evaluate(MEDIR)
    const arqEstadoFechado = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_estado_fechado.png`)
    await page.screenshot({ path: arqEstadoFechado })
    prints.push(arqEstadoFechado)

    if (estadoFechado.sheet.visivel) falhas.push(`${vp.nome}: painel abriu sozinho no estado`)
    if (estadoFechado.sheet.classe.includes('is-open')) {
      falhas.push(`${vp.nome}: sheet com is-open sem ação do usuário`)
    }
    if (estadoFechado.botao?.expandido !== 'false') {
      falhas.push(`${vp.nome}: botão com aria-expanded=${estadoFechado.botao?.expandido}`)
    }
    if ((estadoFechado.botao?.w ?? 0) < 48 || (estadoFechado.botao?.h ?? 0) < 48) {
      falhas.push(`${vp.nome}: alvo do botão abaixo de 48px`)
    }
    if (!estadoFechado.selecao.featuresZonas) falhas.push(`${vp.nome}: sem colunas de zona no estado`)

    // Abrir pelo botão.
    await page.click('[data-prova="detalhe-toggle"]')
    await page.waitForTimeout(900)
    const estadoAberto = await page.evaluate(MEDIR)
    const arqEstadoAberto = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_estado_aberto.png`)
    await page.screenshot({ path: arqEstadoAberto })
    prints.push(arqEstadoAberto)
    if (!estadoAberto.sheet.visivel || !estadoAberto.sheet.classe.includes('is-open')) {
      falhas.push(`${vp.nome}: botão não abriu o painel`)
    }
    if (estadoAberto.botao?.expandido !== 'true') {
      falhas.push(`${vp.nome}: aria-expanded não virou true ao abrir`)
    }
    if (estadoAberto.zoom !== estadoFechado.zoom) {
      falhas.push(`${vp.nome}: zoom mudou ao abrir (${estadoFechado.zoom} → ${estadoAberto.zoom})`)
    }
    if (String(estadoAberto.centro) !== String(estadoFechado.centro)) {
      falhas.push(`${vp.nome}: centro mudou ao abrir`)
    }

    // Fechar pelo botão: seleção continua, zoom continua.
    await page.click('[data-prova="detalhe-toggle"]')
    await page.waitForTimeout(900)
    const estadoRefechado = await page.evaluate(MEDIR)
    if (estadoRefechado.sheet.visivel) falhas.push(`${vp.nome}: botão não fechou o painel`)
    if (!estadoRefechado.selecao.temSelecao) {
      falhas.push(`${vp.nome}: fechar pelo botão limpou a seleção`)
    }
    if (estadoRefechado.selecao.tituloSheet !== estadoFechado.selecao.tituloSheet) {
      falhas.push(`${vp.nome}: conteúdo do painel mudou ao fechar`)
    }
    if (estadoRefechado.zoom !== estadoFechado.zoom) {
      falhas.push(`${vp.nome}: zoom mudou ao fechar (${estadoFechado.zoom} → ${estadoRefechado.zoom})`)
    }
    if (String(estadoRefechado.centro) !== String(estadoFechado.centro)) {
      falhas.push(`${vp.nome}: centro mudou ao fechar`)
    }

    // Fechar por ARRASTE na alça (painel aberto → arrasta 80 px para baixo).
    await page.click('[data-prova="detalhe-toggle"]')
    await page.waitForTimeout(700)
    let fechouPorArraste = false
    const alca = page.locator('.sheet-detalhe .sheet-grip')
    const caixaAlca = await alca.boundingBox()
    if (caixaAlca) {
      const x = caixaAlca.x + caixaAlca.width / 2
      const y = caixaAlca.y + caixaAlca.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x, y + 80, { steps: 10 })
      await page.mouse.up()
      await page.waitForTimeout(800)
      fechouPorArraste = !(await page.evaluate(MEDIR)).sheet.visivel
    }
    if (!fechouPorArraste) falhas.push(`${vp.nome}: arraste na alça não fechou o painel`)

    // ---------------------------------------------------- 3. nível MUNICÍPIO
    await assentar(page, `${opcoes.base}/mapa?uf=CE&m=${CD_TSE_FORTALEZA}&z=10.5`)
    await page.evaluate(() => window.__mapa?.easeTo({ pitch: 52, bearing: 0, duration: 0 }))
    await esperarDetalhe(page, CD_TSE_FORTALEZA)
    await esperarZonas(page)
    await page.waitForTimeout(1800)
    const municipioFechado = await page.evaluate(MEDIR)
    const arqMunFechado = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_municipio_fechado.png`)
    await page.screenshot({ path: arqMunFechado })
    prints.push(arqMunFechado)
    if (municipioFechado.sheet.visivel) falhas.push(`${vp.nome}: painel abriu sozinho no município`)

    await page.click('[data-prova="detalhe-toggle"]')
    await page.waitForTimeout(900)
    const municipioAberto = await page.evaluate(MEDIR)
    const arqMunAberto = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_municipio_aberto.png`)
    await page.screenshot({ path: arqMunAberto })
    prints.push(arqMunAberto)
    if (!municipioAberto.sheet.visivel) falhas.push(`${vp.nome}: painel não abriu no município`)
    if (municipioAberto.zoom !== municipioFechado.zoom) {
      falhas.push(`${vp.nome}: zoom mudou no município`)
    }

    tela.macroAvivo = achatar(comAviso)
    tela.macroFechado = achatar(semAviso)
    tela.estadoFechado = achatar(estadoFechado)
    tela.estadoAberto = achatar(estadoAberto)
    tela.estadoRefechado = achatar(estadoRefechado)
    tela.municipioFechado = achatar(municipioFechado)
    tela.municipioAberto = achatar(municipioAberto)
    tela.fechouPorArraste = fechouPorArraste
    tela.console = filtroConsole(registro.console)
    relatorio.telas[vp.nome] = tela
    if (tela.console.erros.length) {
      falhas.push(`${vp.nome}: console/HTTP — ${tela.console.erros.slice(0, 3).join(' | ')}`)
    }
    await contexto.close()
  }

  // --------------------------------------------------------- desktop (não muda)
  {
    const registro = { console: [] }
    const contexto = await navegador.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    })
    const page = await contexto.newPage()
    instrumentar(page, registro)
    await assentar(page, `${opcoes.base}/mapa?uf=CE&z=6.3`)
    await esperarDetalhe(page, null)
    await page.waitForTimeout(1200)
    const medida = await page.evaluate(() => {
      const caixa = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
                 h: Math.round(r.height), display: s.display, visibility: s.visibility }
      }
      return {
        vp: { w: window.innerWidth, h: window.innerHeight },
        palco: caixa('.map-stage'),
        painelLateral: caixa('.side-panel'),
        detalheCard: caixa('.side-panel .detail-card'),
        titulo: document.querySelector('.side-panel .detail-title')?.textContent
          .replace(/\s+/g, ' ').trim() ?? null,
        aviso: caixa('[data-prova="aviso-desktop"]'),
        botaoDetalhe: caixa('[data-prova="detalhe-toggle"]'),
        sheetDetalhe: caixa('.sheet-detalhe'),
        gaveta: caixa('.placar-gaveta'),
        barraMobile: caixa('.placar-barra'),
        scroll: {
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        },
        zoom: window.__mapa ? Number(window.__mapa.getZoom().toFixed(4)) : null,
      }
    })
    const arqDesktop = path.join(opcoes.out, `${opcoes.prefix}_desktop_1440x900.png`)
    await page.screenshot({ path: arqDesktop })
    const visivel = (c) => c && c.display !== 'none' && c.visibility === 'visible' && c.w > 0
    if (visivel(medida.aviso)) falhas.push('desktop: aviso apareceu no desktop')
    if (visivel(medida.botaoDetalhe)) falhas.push('desktop: botão de detalhes apareceu no desktop')
    if (visivel(medida.sheetDetalhe)) falhas.push('desktop: sheet mobile apareceu no desktop')
    if (!visivel(medida.painelLateral)) falhas.push('desktop: painel lateral sumiu')
    relatorio.telas.desktop = {
      medida,
      console: filtroConsole(registro.console),
      prints: [arqDesktop],
    }
    if (relatorio.telas.desktop.console.erros.length) {
      falhas.push(`desktop: console/HTTP — ${relatorio.telas.desktop.console.erros.slice(0, 3).join(' | ')}`)
    }
    await contexto.close()
  }

  await navegador.close()

  relatorio.falhas = falhas
  relatorio.ok = falhas.length === 0
  const arqRelatorio = path.join(opcoes.out, `${opcoes.prefix}_relatorio.json`)
  await writeFile(arqRelatorio, JSON.stringify(relatorio, null, 2), 'utf8')

  // Resumo enxuto no stdout (o relatório completo fica no JSON).
  const resumo = {}
  for (const [nome, tela] of Object.entries(relatorio.telas)) {
    if (tela.medida) {
      resumo[nome] = {
        painelLateral: tela.medida.painelLateral,
        detalheCard: tela.medida.detalheCard,
        aviso: tela.medida.aviso,
        botaoDetalhe: tela.medida.botaoDetalhe,
        sheet: tela.medida.sheetDetalhe,
        barraMobile: tela.medida.barraMobile,
        zoom: tela.medida.zoom,
        console: tela.console,
      }
      continue
    }
    const linha = (m) =>
      m && {
        palco: `${m.palcoW}x${m.palcoH}`,
        barraH: m.barraH,
        gaveta: m.gaveta,
        sheet: m.sheet,
        botao: m.botao,
        aviso: m.aviso,
        areas: m.areas,
        zoom: m.zoom,
        centro: m.centro,
        scroll: m.scroll,
      }
    resumo[nome] = {
      macroComAviso: linha(tela.macroAvivo),
      macroFechado: linha(tela.macroFechado),
      estadoFechado: linha(tela.estadoFechado),
      estadoAberto: linha(tela.estadoAberto),
      estadoRefechado: linha(tela.estadoRefechado),
      municipioFechado: linha(tela.municipioFechado),
      municipioAberto: linha(tela.municipioAberto),
      fechouPorArraste: tela.fechouPorArraste,
      console: tela.console,
      prints: tela.prints.length,
    }
  }
  console.log(JSON.stringify({ resumo, falhas, ok: relatorio.ok }, null, 2))
  console.log(`relatorio: ${arqRelatorio}`)
  if (falhas.length) process.exit(1)
}

principal().catch((erro) => {
  console.error('ERRO NA PROVA:', erro)
  process.exit(1)
})
