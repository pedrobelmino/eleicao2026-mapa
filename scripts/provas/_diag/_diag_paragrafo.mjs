// Diagnóstico 2: o parágrafo metodológico está cortado por CSS ou apenas fora
// da área visível de um container que rola? Mede o retângulo do parágrafo
// contra o scrollport e a caixa da ÚLTIMA linha (Range.clientRects).
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const base = process.argv[2] || 'http://127.0.0.1:8110'
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

for (const vp of [{ n: 'desktop', w: 1440, h: 900 }, { n: 'mobile', w: 390, h: 844 }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } })
  const page = await ctx.newPage()
  await page.goto(`${base}/mapa?uf=CE&z=6&margem=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.margens-card')].find((el) => el.getBoundingClientRect().width > 0)
    return card && card.querySelectorAll('[data-prova="margem-decisivo"]').length >= 10
  }, { timeout: 90000 })
  await new Promise((r) => setTimeout(r, 2500))
  const dados = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.margens-card')].find((el) => el.getBoundingClientRect().width > 0)
    const notas = [...card.querySelectorAll('.margem-nota')].map((el) => {
      const r = el.getBoundingClientRect()
      const ultimaLinha = []
      const range = document.createRange()
      const nodo = el.firstChild
      if (nodo && nodo.nodeType === 3) {
        range.selectNodeContents(el)
        for (const rect of range.getClientRects()) {
          ultimaLinha.push({ top: Math.round(rect.top), bottom: Math.round(rect.bottom), h: Math.round(rect.height) })
        }
      }
      // scrollport mais próximo
      let pai = el.parentElement
      let scrollport = null
      while (pai && pai !== document.body) {
        const cs = getComputedStyle(pai)
        if (/(auto|scroll)/.test(cs.overflowY)) {
          const rp = pai.getBoundingClientRect()
          scrollport = {
            classe: pai.className,
            top: Math.round(rp.top), bottom: Math.round(rp.bottom),
            scrollTop: pai.scrollTop, scrollHeight: pai.scrollHeight, clientHeight: pai.clientHeight,
          }
          break
        }
        pai = pai.parentElement
      }
      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom), altura: Math.round(r.height),
        scrollport,
        fora_do_scrollport_por: scrollport ? Math.round(Math.max(0, r.bottom - scrollport.bottom)) : null,
        linhas: ultimaLinha,
        ultima_linha_completa: scrollport && ultimaLinha.length
          ? ultimaLinha[ultimaLinha.length - 1].bottom <= scrollport.bottom
          : null,
      }
    })
    return { notas, cardsTexto: card.innerText.slice(-260) }
  })
  console.log(vp.n, JSON.stringify(dados, null, 2))
  await ctx.close()
}
await browser.close()
