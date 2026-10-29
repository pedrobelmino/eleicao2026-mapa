#!/usr/bin/env node
// Prova da separação /sobre x /portfolio (ADV-235), com navegador real.
//
// Mede:
//   * /sobre: só o conteúdo "sobre mim" — sem o card do portfólio;
//   * /portfolio: a página independente com os portfólios;
//   * item "Portfólio" da navegação da /sobre termina em /portfolio;
//   * link legado /sobre#portfolio termina em /portfolio;
//   * a volta: item "Quem sou eu" da /portfolio termina em /sobre.
//
//   cd web && npm run build
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/sobre_portfolio.mjs --base http://127.0.0.1:8100
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao
}

const BASE = argumento('base', 'http://127.0.0.1:8100').replace(/\/+$/, '')

const checagens = []
function confere(nome, esperado, obtido) {
  const ok = JSON.stringify(esperado) === JSON.stringify(obtido)
  checagens.push({ ok, nome, esperado, obtido })
  return ok
}

const ESTADO = `(() => ({
  rota: location.pathname,
  ancora: location.hash,
  titulo: document.title,
  h1Sobre: document.querySelector('.landing-topo h1')?.textContent?.trim() || null,
  selo: document.querySelector('.landing-selo')?.textContent?.trim() || null,
  linha: document.querySelector('.landing-linha')?.textContent?.trim().slice(0, 40) || null,
  portas: [...document.querySelectorAll('.landing-porta .landing-porta-nome')]
    .map((n) => n.textContent.trim()),
  h1Portfolio: document.querySelector('#portfolio h1')?.textContent?.trim() || null,
  produto: document.querySelector('.landing-eleicao h2')?.textContent?.trim() || null,
  ctas: [...document.querySelectorAll('.landing-cta')].map((b) => b.textContent.trim()),
  cardPortfolio: Boolean(document.querySelector('#portfolio .landing-eleicao')),
  topoSobre: Boolean(document.querySelector('.landing-topo')),
  rodape: (document.querySelector('.landing-rodape')?.textContent || '').replace(/\\s+/g, ' ').trim(),
}))()`

async function principal() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const contexto = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await contexto.newPage()
  const erros = []
  page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') erros.push(`console: ${m.text()}`)
  })

  // 1. /sobre — só "Sobre"
  await page.goto(`${BASE}/sobre`, { waitUntil: 'networkidle' })
  const sobre = await page.evaluate(ESTADO)
  confere('/sobre rota', '/sobre', sobre.rota)
  confere('/sobre h1 é Sobre (Pedro Belmino)', 'Pedro Belmino', sobre.h1Sobre)
  confere('/sobre tem selo', 'analista de sistemas', sobre.selo)
  confere(
    '/sobre tem os 4 perfis',
    ['LinkedIn', 'GitHub', 'Medium', 'YouTube · Belmino Souls'],
    sobre.portas,
  )
  confere('/sobre NÃO tem o card do portfólio', false, sobre.cardPortfolio)
  confere('/sobre NÃO tem CTA de portfólio', [], sobre.ctas)
  confere('/sobre tem a linha de identidade no rodapé', true, sobre.rodape.includes('Fortaleza'))
  confere('/sobre título do documento', 'Pedro Belmino — Analista de Sistemas', sobre.titulo)

  // 2. /portfolio — a página independente
  await page.goto(`${BASE}/portfolio`, { waitUntil: 'networkidle' })
  const portfolio = await page.evaluate(ESTADO)
  confere('/portfolio rota', '/portfolio', portfolio.rota)
  confere('/portfolio h1 é Portfólio', 'Portfólio', portfolio.h1Portfolio)
  confere(
    '/portfolio mostra o produto',
    'Eleição 2026 — acompanhamento e mapa',
    portfolio.produto,
  )
  confere(
    '/portfolio mostra os 2 CTAs',
    ['Acompanhar a apuração→', 'Abrir o mapa interativo→'],
    portfolio.ctas,
  )
  confere('/portfolio NÃO tem o bloco Sobre', false, portfolio.topoSobre)
  confere('/portfolio título do documento', 'Portfólio — Pedro Belmino', portfolio.titulo)

  // 3. item "Portfólio" da navegação da /sobre -> /portfolio (sem recarregar)
  await page.goto(`${BASE}/sobre`, { waitUntil: 'networkidle' })
  const timeOriginAntes = await page.evaluate(() => performance.timeOrigin)
  await page.evaluate(() => {
    window.__marcaDeSessao = 'sem-recarregar'
  })
  await page.click('[data-prova="nav-portfolio"]')
  await page.waitForURL(`${BASE}/portfolio`, { timeout: 10000 })
  await page.waitForSelector('#portfolio h1', { timeout: 10000 })
  const nav = await page.evaluate(
    (antes) => ({
      rota: location.pathname,
      h1: document.querySelector('#portfolio h1')?.textContent?.trim(),
      mesmaSessao: window.__marcaDeSessao === 'sem-recarregar',
      mesmoDocumento: performance.timeOrigin === antes,
    }),
    timeOriginAntes,
  )
  confere('item "Portfólio" termina em /portfolio', '/portfolio', nav.rota)
  confere('item "Portfólio" renderiza a página de portfólio', 'Portfólio', nav.h1)
  confere('item "Portfólio" navega sem recarregar', true, nav.mesmaSessao && nav.mesmoDocumento)

  // 4. link legado /sobre#portfolio -> /portfolio (carga completa do endereço)
  await page.goto(`${BASE}/sobre#portfolio`, { waitUntil: 'networkidle' })
  await page.waitForSelector('#portfolio h1', { timeout: 10000 })
  const legado = await page.evaluate(ESTADO)
  confere('link legado termina em /portfolio', '/portfolio', legado.rota)
  confere('link legado renderiza o portfólio', 'Portfólio', legado.h1Portfolio)
  confere('link legado não deixa a âncora na URL', '', legado.ancora)
  confere('link legado não mostra o bloco Sobre', false, legado.topoSobre)

  // 5. volta: "Quem sou eu" na /portfolio -> /sobre
  await page.click('[data-prova="nav-sobre"]')
  await page.waitForURL(`${BASE}/sobre`, { timeout: 10000 })
  const volta = await page.evaluate(ESTADO)
  confere('item "Quem sou eu" termina em /sobre', '/sobre', volta.rota)
  confere('item "Quem sou eu" renderiza o Sobre', 'Pedro Belmino', volta.h1Sobre)

  // 6. regressão: as rotas que já existiam continuam de pé
  await page.goto(`${BASE}/eleicao`, { waitUntil: 'networkidle' })
  const painel = await page.evaluate(() => ({
    rota: location.pathname,
    app: Boolean(document.querySelector('.home-app')),
    placar: document.querySelectorAll('.home-app .placar .cand').length,
  }))
  confere('regressão /eleicao responde', '/eleicao', painel.rota)
  confere('regressão /eleicao monta o painel', true, painel.app)
  confere('regressão /eleicao tem candidatos no placar', true, painel.placar > 0)

  await page.goto(`${BASE}/mapa`, { waitUntil: 'networkidle' })
  await page.waitForSelector('canvas', { timeout: 25000 })
  const mapa = await page.evaluate(() => ({
    rota: location.pathname,
    canvas: document.querySelectorAll('canvas').length,
  }))
  confere('regressão /mapa responde', '/mapa', mapa.rota)
  confere('regressão /mapa desenha o canvas', true, mapa.canvas > 0)

  confere('console sem erro', [], erros)

  await page.close()
  await contexto.close()
  await browser.close()

  const falhas = checagens.filter((c) => !c.ok)
  console.log(
    JSON.stringify(
      {
        base: BASE,
        quando: new Date().toISOString(),
        total: checagens.length,
        passaram: checagens.length - falhas.length,
        falharam: falhas.length,
        checagens,
      },
      null,
      2,
    ),
  )
  process.exit(falhas.length ? 1 : 0)
}

principal().catch((erro) => {
  console.error(erro)
  process.exit(2)
})
