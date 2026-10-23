#!/usr/bin/env node
// Prova da reestruturação em três níveis: / (landing), /eleicao (painel), /mapa (preservado).
//
// Mede, com navegador real:
//   * prints desktop 1440x900 e mobile 390x844 dos três níveis;
//   * os quatro links da landing (texto, href, target/rel, visibilidade);
//   * o placar do /eleicao (presença das métricas, não só "renderizou algo");
//   * o /mapa com o mesmo recorte do instantâneo "antes" (camadas, fontes, zoom, centro);
//   * navegação / -> /eleicao -> /mapa SEM recarregar (same-page, timeOrigin estável);
//   * console limpo e zero request >= 400 em cada nível.
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules node scripts/provas/rotas3niveis.mjs \
//     --base http://127.0.0.1:8100 --out _provas --prefix rotas
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop', largura: 1440, altura: 900 },
  { nome: 'mobile', largura: 390, altura: 844 },
]

const ARGS_GPU = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
]

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8100', out: '_provas', prefix: 'rotas' }
  for (let indice = 0; indice < argv.length; indice += 1) {
    const [chave, valorNaMesmaLinha] = argv[indice].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = valorNaMesmaLinha ?? argv[indice + 1]
    if (valorNaMesmaLinha == null) indice += 1
  }
  opcoes.base = opcoes.base.replace(/\/+$/, '')
  return opcoes
}

function instrumentar(page, registro) {
  page.on('console', (m) => {
    if (m.type() === 'error') registro.console.push(m.text())
  })
  page.on('pageerror', (e) => registro.console.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400) registro.http.push(`${r.status()} ${r.url()}`)
  })
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

const estadoDoMapa = () => {
  const mapa = window.__mapa
  if (!mapa) return null
  try {
    const estilo = mapa.getStyle()
    return {
      camadas: estilo.layers.map((l) => l.id).sort(),
      fontes: Object.keys(estilo.sources).sort(),
      zoom: Number(mapa.getZoom().toFixed(4)),
      centro: mapa.getCenter().toArray().map((n) => Number(n.toFixed(4))),
      pitch: Number(mapa.getPitch().toFixed(2)),
      debug: window.__mapaDebug || null,
    }
  } catch (erro) {
    return { erro: String(erro) }
  }
}

async function nivelLanding(browser, base, out, prefix, viewport, registro) {
  const context = await browser.newContext({
    viewport: { width: viewport.largura, height: viewport.altura },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  instrumentar(page, registro)
  const arquivo = path.join(
    out,
    `${prefix}_landing_${viewport.nome}_${viewport.largura}x${viewport.altura}.png`,
  )

  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('.landing-app h1', { timeout: 20000 })
  await page.waitForTimeout(400)

  const dados = await page.evaluate(() => {
    const titulo = document.querySelector('.landing-app h1')?.textContent?.trim() || ''
    const selo = document.querySelector('.landing-selo')?.textContent?.trim() || ''
    const cta = document.querySelector('.landing-cta')
    const portas = [...document.querySelectorAll('.landing-porta')].map((a) => {
      const r = a.getBoundingClientRect()
      return {
        texto: a.querySelector('.landing-porta-nome')?.textContent?.trim() || '',
        href: a.getAttribute('href'),
        target: a.getAttribute('target'),
        rel: a.getAttribute('rel'),
        visivelAgora: r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0,
        duranteScroll: r.height > 0,
        y: Math.round(r.top + window.scrollY),
      }
    })
    return {
      titulo,
      selo,
      ctaTexto: cta?.textContent?.replace(/\s+/g, ' ').trim() || '',
      ctaHref: cta?.getAttribute('href'),
      portas,
      tituloDocumento: document.title,
      descricao:
        document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
      larguraDocumento: document.documentElement.scrollWidth,
      alturaVisivel: window.innerHeight,
    }
  })

  await page.screenshot({ path: arquivo })

  // No celular os quatro cartões podem passar da dobra: rola até o último link
  // e tira um segundo print, para o aceite "os 4 links visíveis" ser literal.
  let arquivoLinks = null
  const foraDaDobra = dados.portas.filter((p) => !p.visivelAgora).length
  if (foraDaDobra > 0) {
    arquivoLinks = path.join(
      out,
      `${prefix}_landing_links_${viewport.nome}_${viewport.largura}x${viewport.altura}.png`,
    )
    await page.evaluate(() => {
      document.querySelectorAll('.landing-porta')[3].scrollIntoView({ block: 'end' })
    })
    await page.waitForTimeout(500)
    await page.screenshot({ path: arquivoLinks })
  }

  await page.close()
  await context.close()

  return { ...dados, arquivo, arquivoLinks, foraDaDobra }
}

async function nivelEleicao(browser, base, out, prefix, viewport, registro) {
  const context = await browser.newContext({
    viewport: { width: viewport.largura, height: viewport.altura },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  instrumentar(page, registro)
  const arquivo = path.join(
    out,
    `${prefix}_eleicao_${viewport.nome}_${viewport.largura}x${viewport.altura}.png`,
  )

  await page.goto(`${base}/eleicao`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('.home-app .placar .cand', { timeout: 30000 })
  await page.waitForTimeout(1500)

  const dados = await page.evaluate(() => {
    const texto = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() || null
    const candidatos = [...document.querySelectorAll('.home-app .placar .cand')].map((c) => ({
      nome: c.querySelector('.nome')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      num: c.querySelector('.num')?.textContent?.trim() || '',
      votos: c.querySelector('.votos')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    }))
    return {
      placarCandidatos: candidatos,
      titulosCartoes: [...document.querySelectorAll('.home-app .card h2')].map((h) =>
        h.textContent.replace(/\s+/g, ' ').trim(),
      ),
      cabecalho: texto('.home-app .cabecalho-apuracao') || texto('.home-app header.topo'),
      ctaMapa: texto('.home-app .mapa-cta'),
      tituloDocumento: document.title,
      descricao:
        document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
      alturaDocumento: document.querySelector('.home-app')?.scrollHeight || 0,
    }
  })

  await page.screenshot({ path: arquivo })
  await page.close()
  await context.close()
  return { ...dados, arquivo }
}

async function nivelMapa(browser, base, out, prefix, viewport, registro) {
  const context = await browser.newContext({
    viewport: { width: viewport.largura, height: viewport.altura },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  instrumentar(page, registro)
  const arquivo = path.join(
    out,
    `${prefix}_mapa_${viewport.nome}_${viewport.largura}x${viewport.altura}.png`,
  )

  await page.goto(`${base}/mapa`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await assentarMapa(page)
  const estado = await page.evaluate(estadoDoMapa)
  const tituloDocumento = await page.title()
  await page.screenshot({ path: arquivo })
  await page.close()
  await context.close()
  return { arquivo, ...estado, tituloDocumento }
}

// Navegação cliente: uma única Page, um único document. Se o app recarregasse,
// performance.timeOrigin mudaria e a marca em window desapareceria.
async function navegacao(browser, base, registro) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  instrumentar(page, registro)

  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('.landing-cta', { timeout: 20000 })
  const origem = await page.evaluate(() => {
    window.__marcaDeSessao = 'sem-recarregar'
    return performance.timeOrigin
  })

  const medidas = []

  const inicio1 = Date.now()
  await page.click('.landing-cta')
  await page.waitForURL(`${base}/eleicao`, { timeout: 15000 })
  await page.waitForSelector('.home-app .placar .cand', { timeout: 30000 })
  const depois1 = await page.evaluate(() => ({
    url: location.pathname,
    marca: window.__marcaDeSessao || null,
    timeOrigin: performance.timeOrigin,
    navegacoes: performance.getEntriesByType('navigation').length,
    titulo: document.title,
    mesmaAba: document.visibilityState,
  }))
  medidas.push({ de: '/', para: '/eleicao', ms: Date.now() - inicio1, ...depois1 })

  const inicio2 = Date.now()
  await page.click('.home-app .mapa-cta')
  await page.waitForURL(`${base}/mapa`, { timeout: 15000 })
  await page.waitForSelector('canvas.maplibregl-canvas, canvas', { timeout: 25000 })
  await page.waitForFunction(
    () => Boolean(window.__mapaDebug) && Number(window.__mapaDebug.featuresUfs || 0) > 0,
    null,
    { timeout: 30000 },
  )
  const depois2 = await page.evaluate(() => ({
    url: location.pathname,
    marca: window.__marcaDeSessao || null,
    timeOrigin: performance.timeOrigin,
    navegacoes: performance.getEntriesByType('navigation').length,
    titulo: document.title,
    featuresUfs: window.__mapaDebug?.featuresUfs ?? null,
    camadas: window.__mapa?.getStyle().layers.length ?? null,
  }))
  medidas.push({ de: '/eleicao', para: '/mapa', ms: Date.now() - inicio2, ...depois2 })

  // Volta pelo histórico: tem de continuar sem recarregar.
  const inicio3 = Date.now()
  await page.goBack()
  await page.waitForSelector('.home-app .placar .cand', { timeout: 20000 })
  const depois3 = await page.evaluate(() => ({
    url: location.pathname,
    marca: window.__marcaDeSessao || null,
    timeOrigin: performance.timeOrigin,
    navegacoes: performance.getEntriesByType('navigation').length,
    titulo: document.title,
  }))
  medidas.push({ de: '/mapa', para: 'voltar', ms: Date.now() - inicio3, ...depois3 })

  await page.close()
  await context.close()

  const semRecarregar =
    origem === medidas[0].timeOrigin &&
    medidas.every((m) => m.marca === 'sem-recarregar' && m.navegacoes === 1)

  return { origem, medidas, semRecarregar }
}

async function principal() {
  const { base, out, prefix } = lerArgumentos(process.argv.slice(2))
  await mkdir(out, { recursive: true })

  // Duas instâncias de propósito: / e /eleicao não têm canvas e o Chromium com
  // SwiftShader falha no Page.captureScreenshot delas ("Unable to capture
  // screenshot"); o mapa precisa do SwiftShader para desenhar o WebGL.
  const browserSimples = await chromium.launch({ headless: true })
  const browserGpu = await chromium.launch({ headless: true, args: ARGS_GPU })
  const porNivel = {}
  const registros = {}
  const resumo = { base, quando: new Date().toISOString(), niveis: {}, navegacao: null }

  // Executa um nível com o registro de console/http dele e devolve o objeto
  // já com esses dois campos (é o que a checagem final lê).
  async function rodar(nome, executar) {
    const registro = { console: [], http: [] }
    registros[nome] = registro
    const resultado = await executar(registro)
    porNivel[nome] = { ...resultado, console: registro.console, http: registro.http }
  }

  try {
    for (const viewport of VIEWPORTS) {
      await rodar(`landing_${viewport.nome}`, (registro) =>
        nivelLanding(browserSimples, base, out, prefix, viewport, registro),
      )
      await rodar(`eleicao_${viewport.nome}`, (registro) =>
        nivelEleicao(browserSimples, base, out, prefix, viewport, registro),
      )
      await rodar(`mapa_${viewport.nome}`, (registro) =>
        nivelMapa(browserGpu, base, out, prefix, viewport, registro),
      )
    }

    const registroNav = { console: [], http: [] }
    resumo.navegacao = await navegacao(browserGpu, base, registroNav)
    resumo.navegacao.console = registroNav.console
    resumo.navegacao.http = registroNav.http
  } finally {
    await browserSimples.close()
    await browserGpu.close()
  }

  Object.assign(resumo.niveis, porNivel)
  const arquivoResumo = path.join(out, `${prefix}_resumo.json`)
  await writeFile(arquivoResumo, JSON.stringify(resumo, null, 2))

  const problemas = []
  for (const [nome, nivel] of Object.entries(resumo.niveis)) {
    console.log(
      `[${nome}] print=${nivel.arquivo || '—'} console.errors=${nivel.console.length} requests>=400=${nivel.http.length}`,
    )
    for (const item of nivel.console) console.log(`[${nome}]   ! ${item}`)
    for (const item of nivel.http) console.log(`[${nome}]   - ${item}`)
    if (nivel.console.length || nivel.http.length) problemas.push(nome)
  }

  const l = resumo.niveis.landing_desktop
  console.log(`\n[landing] h1="${l.titulo}" selo="${l.selo}" doc.title="${l.tituloDocumento}"`)
  console.log(`[landing] cta="${l.ctaTexto}" href=${l.ctaHref}`)
  for (const p of l.portas) {
    console.log(
      `[landing] porta ${p.texto} href=${p.href} target=${p.target || '—'} rel=${p.rel || '—'} visivel=${p.visivelAgora}`,
    )
  }
  const porViewport = ['desktop', 'mobile']
  for (const v of porViewport) {
    const dados = resumo.niveis[`landing_${v}`]
    const links = dados.portas.map((p) => `${p.texto}:${p.href}`).join(' | ')
    console.log(
      `[landing][${v}] portas=${dados.portas.length} foraDaDobra=${dados.foraDaDobra} scrollWidth=${dados.larguraDocumento} links=(${links})`,
    )
    if (dados.arquivoLinks) console.log(`[landing][${v}] print extra dos links=${dados.arquivoLinks}`)
  }

  for (const v of porViewport) {
    const e = resumo.niveis[`eleicao_${v}`]
    console.log(
      `\n[eleicao][${v}] placar=${e.placarCandidatos.length} candidatos (${e.placarCandidatos
        .map((c) => `${c.nome} ${c.votos}`)
        .join(' · ')})`,
    )
    console.log(`[eleicao][${v}] cartoes=${e.titulosCartoes.length} -> ${e.titulosCartoes.join(' / ')}`)
    console.log(`[eleicao][${v}] doc.title="${e.tituloDocumento}" ctaMapa="${e.ctaMapa}"`)
  }

  for (const v of porViewport) {
    const m = resumo.niveis[`mapa_${v}`]
    console.log(
      `\n[mapa][${v}] camadas=${m.camadas.length} fontes=${m.fontes.join(',')} zoom=${m.zoom} centro=${JSON.stringify(m.centro)} pitch=${m.pitch}`,
    )
    console.log(`[mapa][${v}] __mapaDebug=${JSON.stringify(m.debug)}`)
  }

  console.log('\n[navegacao]')
  for (const m of resumo.navegacao.medidas) {
    console.log(
      `[navegacao] ${m.de} -> ${m.para} url=${m.url} ms=${m.ms} marca=${m.marca || 'PERDIDA'} timeOrigin=${m.timeOrigin} navegacoes=${m.navegacoes} doc.title="${m.titulo}"${m.featuresUfs != null ? ` featuresUfs=${m.featuresUfs} camadas=${m.camadas}` : ''}`,
    )
  }
  console.log(`[navegacao] semRecarregar=${resumo.navegacao.semRecarregar ? 'SIM' : 'NAO'}`)
  console.log(
    `[navegacao] console.errors=${resumo.navegacao.console.length} requests>=400=${resumo.navegacao.http.length}`,
  )
  for (const item of resumo.navegacao.console) console.log(`[navegacao]   ! ${item}`)
  for (const item of resumo.navegacao.http) console.log(`[navegacao]   - ${item}`)
  console.log(`[resumo] ${arquivoResumo}`)

  const ok =
    problemas.length === 0 &&
    resumo.navegacao.semRecarregar &&
    resumo.navegacao.console.length === 0 &&
    resumo.navegacao.http.length === 0 &&
    resumo.niveis.landing_desktop.portas.length === 4 &&
    resumo.niveis.eleicao_desktop.placarCandidatos.length >= 2

  console.log(ok ? '\nPROVA OK: três níveis renderizados, navegação cliente sem recarregar.' : '\nPROVA FALHOU: veja as linhas acima.')
  if (!ok) process.exitCode = 1
}

principal().catch((erro) => {
  console.error('PROVA FALHOU ao executar o Playwright:', erro)
  process.exitCode = 1
})
