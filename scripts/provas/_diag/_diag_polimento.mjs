// Diagnóstico temporário: por que "calculando margens…" não sai e quem são os
// dois .scoreboard--panel. Não é prova — só leitura.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const base = process.argv[2] || 'http://127.0.0.1:8110'
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const reqs = []
page.on('request', (r) => { if (r.url().includes('/api/')) reqs.push(r.url()) })
page.on('response', async (r) => {
  if (!r.url().includes('/api/')) return
  if (r.status() >= 400) console.log('RUIM', r.status(), r.url())
})
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()) })

await page.goto(`${base}/mapa?uf=CE&z=6&margem=1`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => {
  const card = [...document.querySelectorAll('.margens-card')].find((el) => el.getBoundingClientRect().width > 0)
  return card && card.querySelectorAll('[data-prova="margem-decisivo"]').length >= 10
}, { timeout: 90000 })
await new Promise((r) => setTimeout(r, 3000))

const dados = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.margens-card')].map((el) => {
    const c = el.getBoundingClientRect()
    return {
      caixa: { w: Math.round(c.width), h: Math.round(c.height) },
      texto: el.innerText.replace(/\n+/g, ' | ').slice(0, 700),
      tem_nacional: Boolean(el.querySelector('.margens-nacional')),
      carregando: [...el.querySelectorAll('.margem-carregando')].map((p) => p.textContent.trim()),
      erros: [...el.querySelectorAll('.margem-erro')].map((p) => p.textContent.trim()),
      notas: el.querySelectorAll('.margem-nota').length,
    }
  })
  const placares = [...document.querySelectorAll('.scoreboard--panel')].map((el) => {
    const c = el.getBoundingClientRect()
    return {
      caixa: { w: Math.round(c.width), h: Math.round(c.height) },
      pai: el.parentElement?.className,
      avo: el.parentElement?.parentElement?.className,
      rows: el.querySelectorAll('.score-row').length,
      turno: el.querySelector('.scoreboard-turno')?.textContent?.trim(),
    }
  })
  return { cards, placares }
})
console.log(JSON.stringify(dados, null, 2))
console.log('REQS', reqs.filter((u) => u.includes('margens')))
await browser.close()
