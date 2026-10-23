#!/usr/bin/env node
// Diagnóstico da captura mobile: tamanho do canvas, momento do frame e duas
// capturas (uma logo após idle e outra depois de forçar repaint).
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const base = process.argv[2] || 'http://127.0.0.1:8100'
const uf = process.argv[3] || 'CE'
const zoom = process.argv[4] || '5.9'

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
})
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
})
const page = await context.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('console.error:', m.text())
})
await page.goto(`${base}/mapa?uf=${uf}&z=${zoom}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 30000 })
await page.waitForFunction(() => window.__mapaDebug && window.__mapaDebug.featuresZonas > 0, null, {
  timeout: 30000,
})
await page.waitForTimeout(3000)
const info = await page.evaluate(() => {
  const canvas = document.querySelector('canvas.maplibregl-canvas')
  const r = canvas.getBoundingClientRect()
  const cont = canvas.parentElement.getBoundingClientRect()
  const mapa = window.__mapa
  return {
    canvas: { x: r.x, y: r.y, w: r.width, h: r.height, cw: canvas.width, ch: canvas.height },
    container: { x: cont.x, y: cont.y, w: cont.width, h: cont.height },
    zoom: mapa.getZoom(),
    center: mapa.getCenter(),
    pitch: mapa.getPitch(),
    bearing: mapa.getBearing(),
    debug: window.__mapaDebug,
  }
})
console.log(JSON.stringify(info, null, 1))
await page.screenshot({ path: `_provas/diag_mobile_a_${uf}.png` })
await page.evaluate(() => {
  window.__mapa.resize()
  window.__mapa.triggerRepaint()
})
await page.waitForTimeout(4000)
await page.screenshot({ path: `_provas/diag_mobile_b_${uf}.png` })
// Terceira tentativa: espera o idle de verdade e mais 2 s de folga.
await page.evaluate(
  () =>
    new Promise((res) => {
      window.__mapa.once('idle', () => res(true))
      window.__mapa.triggerRepaint()
      setTimeout(() => res(false), 10000)
    }),
)
await page.waitForTimeout(2000)
await page.screenshot({ path: `_provas/diag_mobile_c_${uf}.png` })
const px = await page.evaluate(() => {
  const canvas = document.querySelector('canvas.maplibregl-canvas')
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  return { contexto: gl ? 'ok' : 'nulo', perdido: gl ? gl.isContextLost() : null }
})
console.log('webgl:', JSON.stringify(px))
await browser.close()
