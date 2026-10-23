// diag_rotulos_dup.mjs — QUANTOS rótulos o mapa realmente desenha e ONDE.
import { createRequire } from 'node:module'
const require = createRequire('/home/pedro/.hermes/hermes-agent/node_modules/')
const { chromium } = require('playwright')

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const erros = []
page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()) })
await page.goto('http://127.0.0.1:8110/mapa?uf=SP', { waitUntil: 'networkidle' })
await page.waitForFunction(() => !!window.__mapa, null, { timeout: 60000 })
await page.waitForTimeout(3000)

for (const z of [8, 10.5]) {
  await page.evaluate((zz) => window.__mapa.jumpTo({ zoom: zz }), z)
  await page.waitForTimeout(4000)
  const r = await page.evaluate(() => {
    const m = window.__mapa
    const visiveis = m.getStyle().layers
      .filter((l) => l.type === 'symbol')
      .filter((l) => { try { return m.getLayoutProperty(l.id, 'visibility') !== 'none' } catch { return false } })
      .map((l) => l.id)
    const feas = m.queryRenderedFeatures({ layers: ['municipios-labels'] })
    const rotulos = feas.map((f) => String(f.properties?.nome || ''))
    const dup = {}
    for (const n of rotulos) dup[n] = (dup[n] || 0) + 1
    return {
      zoom: m.getZoom(),
      simbolosVisiveis: visiveis,
      total: rotulos.length,
      repetidos: Object.entries(dup).filter(([, n]) => n > 1),
    }
  })
  console.log(`[z=${z}]`, JSON.stringify(r))
}
console.log('console erros:', erros.length)
await browser.close()
