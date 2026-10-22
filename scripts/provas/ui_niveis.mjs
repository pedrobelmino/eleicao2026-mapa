#!/usr/bin/env node
// Prova por nível de zoom: legenda, rótulos de município e encobrimento pelos
// prismas. Roda contra a stack de teste (8100) ou produção local (8110):
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/ui_niveis.mjs --base http://127.0.0.1:8110 --prefixo depois
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

function argumentos(argv) {
  const saida = {
    base: 'http://127.0.0.1:8110',
    out: '_provas/mapa-ui',
    prefixo: 'niveis',
    uf: 'CE',
  }
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

const NIVEIS = [
  { rotulo: 'macro', zoom: 3.1, municipio: false },
  { rotulo: 'estado', zoom: 6.3, municipio: false },
  { rotulo: 'municipio', zoom: 8.7, municipio: false },
  { rotulo: 'local', zoom: 10.2, municipio: false },
]

async function leitura(pagina) {
  return pagina.evaluate(() => {
    const legenda = document.querySelector('.legend')
    const itens = legenda
      ? [...legenda.querySelectorAll('.legend-itens li')].map((li) => li.textContent.trim())
      : []
    const camadas = window.__mapa ? window.__mapa.getStyle().layers.map((l) => l.id) : []
    const rotulos = camadas.includes('municipios-labels')
      ? window.__mapa.queryRenderedFeatures({ layers: ['municipios-labels'] }).length
      : 0
    const prismas = camadas.filter((id) => id.startsWith('zonas-prisma-'))
    const prismasVisiveis = prismas.filter((id) => window.__mapa.getLayer(id))
    return {
      zoom: Number(window.__mapa.getZoom().toFixed(2)),
      titulo: legenda ? legenda.querySelector('.legend-title')?.textContent.trim() : '(sem legenda)',
      nivel: legenda?.dataset.nivel ?? '',
      itens,
      nota: legenda ? [...legenda.querySelectorAll('.legend-note')].map((p) => p.textContent.trim()) : [],
      segmentos: legenda
        ? [...legenda.querySelectorAll('.legend-segmentos li')].map((li) => li.textContent.trim())
        : [],
      regra: legenda?.querySelector('.legend-regra')?.textContent.trim() ?? '',
      rotulosDesenhados: rotulos,
      camadasPrisma: prismasVisiveis.length,
    }
  })
}

async function principal() {
  const { base, out, prefixo, uf } = argumentos(process.argv.slice(2))
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
  const erros = []
  pagina.on('console', (msg) => {
    if (msg.type() === 'error') erros.push(msg.text())
  })
  pagina.on('pageerror', (erro) => erros.push(`pageerror: ${erro.message}`))

  await pagina.goto(`${base}/mapa?uf=${uf}`, { waitUntil: 'domcontentloaded' })
  await pagina.waitForFunction(
    () => Boolean(window.__mapa) && window.__mapa.loaded(),
    null,
    { timeout: 45000 },
  )
  await pagina.waitForTimeout(3000)

  console.log(`url=${base}/mapa?uf=${uf}`)
  // Selo do código da eleição: o texto e o tooltip que explicam o número.
  const selo = await pagina.evaluate(() => {
    const badge = document.querySelector('.header-badge')
    if (!badge) return null
    return {
      texto: badge.textContent.replace(/\s+/g, ' ').trim(),
      title: badge.getAttribute('title'),
      aria: badge.getAttribute('aria-label'),
    }
  })
  console.log(`selo: "${selo?.texto ?? '(sem selo)'}"`)
  console.log(`selo.title="${selo?.title ?? ''}"`)
  console.log(`selo.aria-label="${selo?.aria ?? ''}"`)
  for (const nivel of NIVEIS) {
    await pagina.evaluate((z) => window.__mapa.jumpTo({ zoom: z, bearing: 0, pitch: 0 }), nivel.zoom)
    await pagina.waitForTimeout(1800)
    const dados = await leitura(pagina)
    const arquivo = `${out}/${prefixo}_${nivel.rotulo}_1440x900.png`
    await pagina.screenshot({ path: arquivo })
    console.log('')
    console.log(`[${nivel.rotulo}] zoom=${dados.zoom} nivel_legenda=${dados.nivel}`)
    console.log(`  titulo: ${dados.titulo}`)
    for (const item of dados.itens) console.log(`  item: ${item}`)
    for (const segmento of dados.segmentos) console.log(`  segmento: ${segmento}`)
    if (dados.regra) console.log(`  regra: ${dados.regra}`)
    for (const nota of dados.nota) console.log(`  nota: ${nota}`)
    console.log(`  rotulos_municipio_desenhados=${dados.rotulosDesenhados} camadas_prisma=${dados.camadasPrisma}`)
    console.log(`  print=${arquivo}`)
  }

  console.log('')
  console.log(`console.errors=${erros.length}`)
  for (const erro of erros) console.log(`  - ${erro}`)

  await contexto.close()
  await browser.close()
  if (erros.length > 0) process.exitCode = 1
}

principal().catch((erro) => {
  console.error('FALHOU:', erro)
  process.exitCode = 1
})
