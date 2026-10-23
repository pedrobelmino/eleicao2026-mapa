#!/usr/bin/env node
// DIAGNÓSTICO (temporário): varre zooms e mostra, por nome de lugar, quantas
// vezes cada camada de símbolo o desenhou. Objetivo: localizar A FONTE da
// duplicata (basemap x nossa camada x repetição por tile da mesma camada).
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const BASE = 'http://127.0.0.1:8110'
const CASOS = [
  { nome: 'fortaleza_z10.5', uf: 'CE', centro: [-38.5433, -3.7172], zoom: 10.5 },
  { nome: 'fortaleza_z11', uf: 'CE', centro: [-38.5433, -3.7172], zoom: 11 },
  { nome: 'fortaleza_z12', uf: 'CE', centro: [-38.5433, -3.7172], zoom: 12 },
  { nome: 'fortaleza_z12.5', uf: 'CE', centro: [-38.5433, -3.7172], zoom: 12.5 },
  { nome: 'fortaleza_z13.5', uf: 'CE', centro: [-38.5433, -3.7172], zoom: 13.5 },
  { nome: 'ce_z8', uf: 'CE', centro: [-39.5, -5.2], zoom: 8 },
  { nome: 'ce_z9', uf: 'CE', centro: [-39.5, -5.2], zoom: 9 },
  { nome: 'sp_z6.4', uf: 'SP', centro: [-46.6333, -23.5505], zoom: 6.4 },
]

const auditoria = () => {
  const mapa = window.__mapa
  const estilo = mapa.getStyle()
  const simbolos = (estilo?.layers || []).filter((l) => l.type === 'symbol').map((l) => l.id)
  const existentes = simbolos.filter((id) => mapa.getLayer(id))
  const visiveis = existentes.filter(
    (id) => (mapa.getLayoutProperty(id, 'visibility') ?? 'visible') !== 'none',
  )
  const grupos = new Map()
  const adicionar = (props, camadaId) => {
    const bruto = props.nome ?? props.name ?? props.uf ?? props['name:en'] ?? ''
    const texto = String(bruto).replace(/\s+/g, ' ').trim()
    if (!texto) return
    const chave = texto.toLowerCase()
    if (!grupos.has(chave)) grupos.set(chave, { texto, camadas: {} })
    const g = grupos.get(chave)
    g.camadas[camadaId] = (g.camadas[camadaId] || 0) + 1
  }
  let n = 0
  try {
    const feats = mapa.queryRenderedFeatures({ layers: visiveis })
    for (const f of feats) {
      if (!f.layer || !visiveis.includes(f.layer.id)) continue
      adicionar(f.properties || {}, f.layer.id)
      n += 1
    }
  } catch (e) {
    return { erro: String(e && e.message ? e.message : e) }
  }
  const lista = [...grupos.values()].map((g) => ({
    texto: g.texto,
    total: Object.values(g.camadas).reduce((a, b) => a + b, 0),
    camadas: g.camadas,
  }))
  lista.sort((a, b) => b.total - a.total)
  return {
    zoom: Number(mapa.getZoom().toFixed(2)),
    featuresNaQuery: n,
    camadasVisiveis: visiveis.map((id) => {
      const d = mapa.getLayer(id)
      return `${id}[${d.minzoom ?? '-'},${d.maxzoom ?? '-'}]`
    }),
    ocultas: existentes.filter((id) => !visiveis.includes(id)),
    lista,
  }
}

const navegador = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const pagina = await contexto.newPage()
const erros = []
pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()) })
pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message))

for (const c of CASOS) {
  await pagina.goto(`${BASE}/mapa?uf=${c.uf}`, { waitUntil: 'domcontentloaded' })
  await pagina.waitForFunction(() => Boolean(window.__mapa) && window.__mapa.loaded(), null, { timeout: 45000 })
  for (let i = 0; i < 2; i += 1) {
    await pagina.evaluate(({ centro, z }) => window.__mapa.jumpTo({ center: centro, zoom: z, bearing: 0, pitch: 0 }), { centro: c.centro, z: c.zoom })
    await pagina.waitForTimeout(2500)
  }
  const d = await pagina.evaluate(auditoria)
  await pagina.screenshot({ path: `_provas/varre_${c.nome}_desktop_1440x900.png` })
  console.log('')
  console.log(`### ${c.nome} zoom=${d.zoom} features=${d.featuresNaQuery}`)
  if (d.erro) { console.log('ERRO ' + d.erro); continue }
  console.log('  visiveis: ' + d.camadasVisiveis.join(' '))
  console.log('  ocultas : ' + (d.ocultas.join(' ') || '(nenhuma)'))
  for (const item of d.lista) {
    const marca = item.total > 1 ? '  <<< DUPLICADO' : ''
    console.log(`  ${item.texto}: ${item.total}x ${JSON.stringify(item.camadas)}${marca}`)
  }
  console.log('  console erros: ' + (erros.length ? erros.join(' | ') : 'limpo'))
  erros.length = 0
}
await navegador.close()
