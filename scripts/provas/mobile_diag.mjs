#!/usr/bin/env node
// DIAGNÓSTICO do layout mobile do /mapa: mede a geometria real (mapa x placar x
// legenda x controles) e imprime um JSON. Serve para decidir a correção com
// número, não com impressão de print.
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/mobile_diag.mjs http://127.0.0.1:8110 _provas diag_mobile_antes
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const base = (process.argv[2] || 'http://127.0.0.1:8110').replace(/\/+$/, '')
const out = process.argv[3] || '_provas'
const prefixo = process.argv[4] || 'diag_mobile'
const url = process.argv[5] || '/mapa?uf=CE&z=5.9'

const VIEWPORTS = [
  { nome: '390x844', width: 390, height: 844 },
  { nome: '390x700', width: 390, height: 700 },
]

function medir() {
  const r = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      x: Math.round(b.x),
      y: Math.round(b.y),
      w: Math.round(b.width),
      h: Math.round(b.height),
      bottom: Math.round(b.bottom),
      display: cs.display,
      visibility: cs.visibility,
      position: cs.position,
      zIndex: cs.zIndex,
      fontSize: cs.fontSize,
      overflowY: cs.overflowY,
    }
  }
  const controles = [...document.querySelectorAll('.maplibregl-ctrl-group button')].map(
    (b) => {
      const x = b.getBoundingClientRect()
      return { w: Math.round(x.width), h: Math.round(x.height), x: Math.round(x.x), y: Math.round(x.y) }
    },
  )
  const doc = document.documentElement
  const linhasPlacar = [...document.querySelectorAll('.scoreboard--panel .score-row, .scoreboard--sheet .score-row')].map(
    (el) => {
      const b = el.getBoundingClientRect()
      return { w: Math.round(b.width), h: Math.round(b.height), y: Math.round(b.y) }
    },
  )
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    doc: {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      scrollHeight: doc.scrollHeight,
      clientHeight: doc.clientHeight,
      bodyOverflow: getComputedStyle(document.body).overflow,
    },
    header: r('.site-header'),
    workspace: r('.workspace'),
    mapaStage: r('.map-stage'),
    canvas: r('canvas.maplibregl-canvas'),
    sidePanel: r('.side-panel'),
    scoreboardPanel: r('.scoreboard--panel'),
    scoreboardSheet: r('.scoreboard--sheet'),
    sheet: r('.bottom-sheet'),
    sheetHeader: r('.sheet-header'),
    legend: r('.legend'),
    nivel: r('.nivel-indicador'),
    rodape: r('.rodape-site'),
    controles,
    linhasPlacar,
    placarTexto: document.querySelector('.scoreboard--panel')?.innerText.replace(/\s+/g, ' ') || null,
  }
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
})

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()
  const erros = []
  page.on('console', (m) => {
    if (m.type() === 'error') erros.push(m.text())
  })
  page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`))
  await page.goto(`${base}${url}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 30000 })
  await page.waitForFunction(() => window.__mapaDebug && window.__mapaDebug.featuresZonas > 0, null, {
    timeout: 30000,
  })
  await page.waitForTimeout(2500)
  const geo = await page.evaluate(medir)
  console.log(`### ${vp.nome}`)
  console.log(JSON.stringify(geo, null, 1))
  console.log(`console.errors: ${erros.length ? erros.join(' | ') : 'nenhum'}`)
  await page.screenshot({ path: `${out}/${prefixo}_${vp.nome}.png` })
  await context.close()
}

await browser.close()
