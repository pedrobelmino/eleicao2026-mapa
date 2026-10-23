#!/usr/bin/env node
// Prova dos RÓTULOS DE LUGAR: conta quantas vezes o mesmo nome de município /
// estado é desenhado no mapa e falha se algum aparecer mais de uma vez.
//
// O bug que isto vigia: o basemap CARTO Positron desenha "Fortaleza" e "CE" e
// nós desenhamos a camada `municipios-labels` / `ufs-labels` por cima -> nome
// duplicado (2-3x) na tela. A regra vale para toda a faixa de zoom: cada nome
// de lugar tem que ter UMA fonte só.
//
// Uso:
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/rotulos_unicos.mjs --base http://127.0.0.1:8110 \
//     --out _provas --prefixo rotulos
//
// Sai 0 só se nenhuma duplicata for encontrada. Imprime, por cenário, a lista
// agrupada (nome -> camadas que o desenharam) para servir de prova no relatório.

import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop', largura: 1440, altura: 900, toque: false },
  { nome: 'mobile', largura: 390, altura: 844, toque: true },
]

// Centros e zooms do relatório do Pedro: Fortaleza em 10.5 e 12, São Paulo em
// 6.4 (nível de estado, onde "CE"/"SP" convivem com o nome da capital).
const CENARIOS = [
  {
    nome: 'fortaleza_z10.5',
    uf: 'CE',
    centro: [-38.5433, -3.7172],
    zoom: 10.5,
    // No celular a faixa útil é mais curta: mantém o centro e sobe um pouco o
    // zoom só se preciso for medir; o alvo do Pedro é o mesmo z.
    zoomMobile: 10.5,
  },
  {
    nome: 'fortaleza_z12',
    uf: 'CE',
    centro: [-38.5433, -3.7172],
    zoom: 12,
    zoomMobile: 12,
  },
  {
    nome: 'sp_z6.4',
    uf: 'SP',
    centro: [-46.6333, -23.5505],
    zoom: 6.4,
    zoomMobile: 6.4,
  },
]

function argumentos(argv) {
  const saida = {
    base: 'http://127.0.0.1:8110',
    out: '_provas',
    prefixo: 'rotulos',
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

// Texto que a camada de símbolo realmente desenha, na ordem em que o MapLibre
// resolveria o text-field do estilo. Basta para achar a duplicata: as camadas
// do basemap usam `name` (places/pois/water) e as nossas usam `nome`/`uf`.
function textoDoFeature(propriedades) {
  if (!propriedades) return ''
  const bruto =
    propriedades.nome ??
    propriedades.name ??
    propriedades.uf ??
    propriedades['name:en'] ??
    ''
  return String(bruto).replace(/\s+/g, ' ').trim()
}

async function auditar(pagina) {
  return pagina.evaluate(() => {
    const mapa = window.__mapa
    if (!mapa) return { erro: 'window.__mapa ausente' }
    const estilo = mapa.getStyle()
    const simb = (estilo?.layers || [])
      .filter((l) => l.type === 'symbol')
      .map((l) => l.id)
    const existentes = simb.filter((id) => Boolean(mapa.getLayer(id)))
    const camadas = existentes.map((id) => {
      const definicao = mapa.getLayer(id)
      return {
        id,
        fonte: definicao?.source,
        visibilidade:
          mapa.getLayoutProperty(id, 'visibility') ??
          definicao?.layout?.visibility ??
          'visible',
        minzoom: definicao?.minzoom ?? null,
        maxzoom: definicao?.maxzoom ?? null,
      }
    })

    let features = []
    try {
      features = mapa.queryRenderedFeatures({ layers: existentes })
    } catch (erro) {
      return { erro: String(erro && erro.message ? erro.message : erro) }
    }

    // Agrupa por texto (sem caixa: o basemap faz uppercase via layout).
    const grupos = new Map()
    for (const f of features) {
      if (!f.layer || !f.layer.id) continue
      if (!existentes.includes(f.layer.id)) continue
      const props = f.properties || {}
      const bruto =
        props.nome ?? props.name ?? props.uf ?? props['name:en'] ?? ''
      const texto = String(bruto).replace(/\s+/g, ' ').trim()
      if (!texto) continue
      // Rótulo de rua/rio/POI não entra na regra: o alvo é município e estado.
      const chaveBase = texto.toLowerCase()
      if (!grupos.has(chaveBase)) {
        grupos.set(chaveBase, {
          texto,
          camadas: new Map(),
          total: 0,
        })
      }
      const grupo = grupos.get(chaveBase)
      grupo.total += 1
      const atual = grupo.camadas.get(f.layer.id) || 0
      grupo.camadas.set(f.layer.id, atual + 1)
    }

    const lista = [...grupos.values()]
      .map((g) => ({
        texto: g.texto,
        total: g.total,
        camadas: [...g.camadas.entries()].map(([id, n]) => ({ id, n })),
      }))
      .sort((a, b) => b.total - a.total || a.texto.localeCompare(b.texto))

    return {
      zoom: Number(mapa.getZoom().toFixed(2)),
      centro: [Number(mapa.getCenter().lng.toFixed(3)), Number(mapa.getCenter().lat.toFixed(3))],
      camadas,
      lista,
    }
  })
}

// Duplicata = o MESMO nome saindo de duas camadas diferentes (nosso rótulo +
// basemap) ou duas vezes da mesma camada (dois features com o mesmo nome).
function duplicatas(lista) {
  return lista.filter((item) => item.total > 1)
}

async function principal() {
  const { base, out, prefixo } = argumentos(process.argv.slice(2))
  await mkdir(out, { recursive: true })
  const navegador = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })

  const falhas = []
  let totalCenarios = 0

  for (const viewport of VIEWPORTS) {
    const contexto = await navegador.newContext({
      viewport: { width: viewport.largura, height: viewport.altura },
      hasTouch: viewport.toque,
      deviceScaleFactor: 1,
    })
    const pagina = await contexto.newPage()
    const erros = []
    pagina.on('console', (msg) => {
      if (msg.type() === 'error') erros.push(msg.text())
    })
    pagina.on('pageerror', (erro) => erros.push(`pageerror: ${erro.message}`))

    for (const cenario of CENARIOS) {
      totalCenarios += 1
      const zoom = viewport.nome === 'mobile' ? cenario.zoomMobile : cenario.zoom
      await pagina.goto(`${base}/mapa?uf=${cenario.uf}`, { waitUntil: 'domcontentloaded' })
      await pagina.waitForFunction(
        () => Boolean(window.__mapa) && window.__mapa.loaded(),
        null,
        { timeout: 45000 },
      )
      await pagina.evaluate(
        ({ centro, z }) =>
          window.__mapa.jumpTo({ center: centro, zoom: z, bearing: 0, pitch: 0 }),
        { centro: cenario.centro, z: zoom },
      )
      // Duas passadas de idle: a primeira fecha o carregamento dos tiles, a
      // segunda deixa o estilo assentar (styledata/zoom já reaplicaram a regra).
      await pagina.waitForTimeout(2500)
      await pagina.evaluate(
        ({ centro, z }) =>
          window.__mapa.jumpTo({ center: centro, zoom: z, bearing: 0, pitch: 0 }),
        { centro: cenario.centro, z: zoom },
      )
      await pagina.waitForTimeout(2500)

      const dados = await auditar(pagina)
      const arquivo = `${out}/${prefixo}_${cenario.nome}_${viewport.nome}_${viewport.largura}x${viewport.altura}.png`
      await pagina.screenshot({ path: arquivo })

      console.log('')
      console.log(`[${cenario.nome} / ${viewport.nome}] zoom=${dados.zoom ?? '?'} centro=${JSON.stringify(dados.centro)}`)
      console.log(`print: ${arquivo}`)
      if (dados.erro) {
        console.log(`ERRO na auditoria: ${dados.erro}`)
        falhas.push(`${cenario.nome}/${viewport.nome}: ${dados.erro}`)
        continue
      }
      for (const camada of dados.camadas) {
        const vis = camada.visibilidade === 'none' ? 'oculta' : 'visivel'
        console.log(
          `  camada ${camada.id} src=${camada.fonte ?? '?'} ${vis} z[${camada.minzoom ?? '-'},${camada.maxzoom ?? '-'}]`,
        )
      }
      const dup = duplicatas(dados.lista)
      const rotulos = dados.lista.filter((i) => i.total >= 1).length
      console.log(`  nomes desenhados=${rotulos} duplicados=${dup.length}`)
      for (const item of dup) {
        const onde = item.camadas.map((c) => `${c.id}${c.n > 1 ? `×${c.n}` : ''}`).join(' + ')
        console.log(`  DUPLICADO "${item.texto}" total=${item.total} -> ${onde}`)
        falhas.push(`${cenario.nome}/${viewport.nome}: "${item.texto}" ${onde}`)
      }
      const errosCenario = erros.splice(0)
      if (errosCenario.length) {
        console.log(`  console: ${errosCenario.length} erro(s)`)
        for (const erro of errosCenario) {
          console.log(`    ${erro}`)
          falhas.push(`${cenario.nome}/${viewport.nome}: console -> ${erro}`)
        }
      } else {
        console.log('  console: limpo')
      }
    }
    await contexto.close()
  }

  await navegador.close()
  console.log('')
  console.log(`cenarios=${totalCenarios} falhas=${falhas.length}`)
  if (falhas.length) {
    console.log('FALHOU')
    for (const falha of falhas) console.log(`  - ${falha}`)
    process.exitCode = 1
    return
  }
  console.log('OK: nenhum nome de município/estado duplicado')
}

principal().catch((erro) => {
  console.error(erro)
  process.exitCode = 1
})
