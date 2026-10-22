#!/usr/bin/env node
// Prova do controle de mouse: botão direito arrastando na vertical tem de dar
// ZOOM, e o bearing tem de continuar 0 (nunca inclinação lateral).
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/mouse_rotacao.mjs --base http://127.0.0.1:8110
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

function argumentos(argv) {
  const saida = { base: 'http://127.0.0.1:8110', out: '_provas/mapa-ui', prefixo: 'mouse' }
  for (let i = 0; i < argv.length; i += 1) {
    const [chave, mesmo] = argv[i].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in saida)) continue
    saida[nome] = mesmo ?? argv[i + 1]
    if (mesmo == null) i += 1
  }
  return saida
}

const estado = (pagina) =>
  pagina.evaluate(() => ({
    zoom: Number(window.__mapa.getZoom().toFixed(3)),
    bearing: Number(window.__mapa.getBearing().toFixed(3)),
    pitch: Number(window.__mapa.getPitch().toFixed(3)),
  }))

async function principal() {
  const { base, out, prefixo } = argumentos(process.argv.slice(2))
  await mkdir(out, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })
  const contexto = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pagina = await contexto.newPage()
  await pagina.goto(`${base}/mapa?uf=CE`, { waitUntil: 'domcontentloaded' })
  await pagina.waitForFunction(() => Boolean(window.__mapa) && window.__mapa.loaded(), null, { timeout: 45000 })
  await pagina.waitForTimeout(2500)

  const caixa = await pagina.locator('canvas').first().boundingBox()
  const cx = caixa.x + caixa.width / 2
  const cy = caixa.y + caixa.height / 2

  // Arrasto VERTICAL para CIMA (aproximando) com o botão direito: tem de dar
  // zoom in. A posição Y inicial é a referência do gesto.
  const antes = await estado(pagina)
  await pagina.mouse.move(cx, cy)
  await pagina.mouse.down({ button: 'right' })
  for (let passo = 1; passo <= 10; passo += 1) {
    await pagina.mouse.move(cx, cy - passo * 22)
    await pagina.waitForTimeout(16)
  }
  await pagina.mouse.up({ button: 'right' })
  await pagina.waitForTimeout(900)
  const depoisVertical = await estado(pagina)

  // Arrasto LATERAL com o botão direito: não pode inclinar (bearing) nem mexer
  // no zoom — o eixo horizontal não é canal de nada.
  await pagina.mouse.move(cx, cy)
  await pagina.mouse.down({ button: 'right' })
  for (let passo = 1; passo <= 10; passo += 1) {
    await pagina.mouse.move(cx + passo * 26, cy)
    await pagina.waitForTimeout(16)
  }
  await pagina.mouse.up({ button: 'right' })
  await pagina.waitForTimeout(900)
  const depoisLateral = await estado(pagina)

  const menu = await pagina.evaluate(() => ({
    eventos: window.__contextmenuEventos ?? -1,
    aberto: window.__contextmenuAberto === true,
  }))
  const arquivo = `${out}/${prefixo}_botao-direito.png`
  await pagina.screenshot({ path: arquivo })

  console.log(`url=${base}/mapa?uf=CE`)
  console.log(`antes            zoom=${antes.zoom} bearing=${antes.bearing} pitch=${antes.pitch}`)
  console.log(`depois_vertical  zoom=${depoisVertical.zoom} bearing=${depoisVertical.bearing} pitch=${depoisVertical.pitch}`)
  console.log(`depois_lateral   zoom=${depoisLateral.zoom} bearing=${depoisLateral.bearing} pitch=${depoisLateral.pitch}`)
  console.log(`contextmenu: eventos=${menu.eventos} menu_aberto=${menu.aberto}`)
  console.log(`print=${arquivo}`)

  const problemas = []
  const deltaZoom = Number((depoisVertical.zoom - antes.zoom).toFixed(3))
  if (deltaZoom < 0.3) {
    problemas.push(`arrasto vertical não deu zoom (${antes.zoom} -> ${depoisVertical.zoom})`)
  }
  for (const [rotulo, valor] of [['depois_vertical', depoisVertical], ['depois_lateral', depoisLateral]]) {
    if (valor.bearing !== 0) problemas.push(`${rotulo}: bearing=${valor.bearing} (quer 0)`)
    if (Math.abs(valor.pitch - antes.pitch) > 0.5) {
      problemas.push(`${rotulo}: pitch=${valor.pitch} mudou (era ${antes.pitch}) — botão direito não inclina`)
    }
  }
  if (Math.abs(depoisLateral.zoom - depoisVertical.zoom) > 0.001) {
    problemas.push(`arrasto lateral mexeu no zoom (${depoisVertical.zoom} -> ${depoisLateral.zoom})`)
  }
  if (menu.eventos < 1) problemas.push('nenhum evento contextmenu chegou ao canvas')
  if (menu.aberto) problemas.push('menu de contexto abriu no canvas')

  if (problemas.length > 0) {
    for (const problema of problemas) console.log(`FALHOU: ${problema}`)
    process.exitCode = 1
  } else {
    console.log(
      `OK: botão direito deu zoom (${deltaZoom > 0 ? '+' : ''}${deltaZoom}), bearing 0 nas duas provas, pitch intacto (${antes.pitch}) e menu de contexto suprimido`,
    )
  }

  await contexto.close()
  await browser.close()
}

principal().catch((erro) => {
  console.error('FALHOU:', erro)
  process.exitCode = 1
})
