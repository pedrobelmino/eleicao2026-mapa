#!/usr/bin/env node
// Prova dos RÓTULOS DE LUGAR por nível de zoom (item 4b do ROADMAP).
//
// Bug que isto vigia: no zoom de cidade o basemap CARTO Positron desenha o
// nome do município (source-layer `places` do source `protomaps`) e a nossa
// camada `municipios-labels` desenha o MESMO nome por cima -> o nome aparece
// duas vezes na tela. Regra: UMA fonte de rótulo por faixa de zoom, decidida
// por fonteDeRotuloPorZoom (web/src/mapa.js).
//
// Como mede (o detalhe que faz a medida valer):
//  1. só camadas de símbolo REALMENTE ativas: existem, visibility != none e
//     minzoom <= z < maxzoom;
//  2. o texto é resolvido pelo `text-field` da PRÓPRIA camada (primeiro campo
//     da expressão que existe nas propriedades). Sem isso `ufs-labels` — que
//     desenha ["get","uf"] = "SP" — seria contado como "São Paulo" (props.nome)
//     e a prova inventaria uma duplicata que não existe na tela;
//  3. duplicata = duas INSTÂNCIAS visíveis do mesmo texto em posições
//     diferentes. O mesmo polígono devolvido por dois tiles cai na mesma âncora
//     (arredondada em 8 px) e conta UMA vez — duplicata de tile não é
//     duplicata de tela;
//  4. tudo é filtrado pelo viewport: âncora fora da tela não está sendo lida
//     por ninguém.
//
// Uso (NODE_PATH com o playwright do Hermes):
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/rotulos.mjs --base http://127.0.0.1:8110
//
// Saída: _provas/rotulos_resumo.json + _provas/rotulos_{UF}_{viewport}_z{z}.png
// rc=0 só se a cidade-alvo aparecer 1 vez em TODOS os cenários (z8, z9.5,
// z10.5, desktop e mobile), console limpo e nenhum request >= 400.

import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop_1440x900', largura: 1440, altura: 900, toque: false },
  { nome: 'mobile_390x844', largura: 390, altura: 844, toque: true },
]

const ZOOMS = [8, 9.5, 10.5]

const UFS = [
  { uf: 'CE', cidade: 'Fortaleza', centro: [-38.5433, -3.7172], m: '13897' },
  { uf: 'SP', cidade: 'São Paulo', centro: [-46.6333, -23.5505], m: '71072' },
]

function argumentos(argv) {
  const saida = {
    base: 'http://127.0.0.1:8110',
    out: '_provas',
    prefixo: 'rotulos',
    resumo: null,
    drill: 'sim',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const [chave, mesmo] = argv[i].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in saida)) continue
    saida[nome] = mesmo ?? argv[i + 1]
    if (mesmo == null) i += 1
  }
  if (!saida.resumo) saida.resumo = `${saida.out}/${saida.prefixo}_resumo.json`
  return saida
}

function zTexto(z) {
  return String(Number(z.toFixed(1)))
}

// Executa DENTRO da página.
function coletar({ cidadeAlvo, viewport }) {
  const mapa = window.__mapa
  if (!mapa) return { erro: 'window.__mapa ausente' }
  const zoom = mapa.getZoom()

  // 1. camadas de símbolo ativas
  const estiloLayers = mapa.getStyle()?.layers || []
  const specPorId = new Map(estiloLayers.map((l) => [l.id, l]))
  const simbolos = estiloLayers.filter((l) => l.type === 'symbol')
  const ativas = simbolos.filter((l) => {
    const def = mapa.getLayer(l.id)
    if (!def) return false
    const vis = mapa.getLayoutProperty(l.id, 'visibility') ?? 'visible'
    if (vis === 'none') return false
    const min = def.minzoom ?? 0
    const max = def.maxzoom ?? 24
    return zoom >= min && zoom < max
  })

  // 2. texto resolvido pelo text-field da camada
  const camposDe = (expressao) => {
    const campos = []
    const anda = (e) => {
      if (!Array.isArray(e)) return
      if (e[0] === 'get') {
        campos.push(e[1])
        return
      }
      for (const parte of e.slice(1)) anda(parte)
    }
    anda(expressao)
    return campos
  }
  const textoDe = (camada, props) => {
    const tf = camada?.layout?.['text-field']
    const campos = tf != null ? camposDe(tf) : []
    for (const campo of campos) {
      const valor = props?.[campo]
      if (valor != null && String(valor).trim() !== '') return String(valor).trim()
    }
    return String(props?.nome ?? props?.name ?? '').trim()
  }

  let features = []
  try {
    features = mapa.queryRenderedFeatures({ layers: ativas.map((l) => l.id) })
  } catch (erro) {
    return { erro: String(erro?.message ?? erro) }
  }

  const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim()
  const ancoraDe = (geometria) => {
    try {
      let ponto = null
      if (geometria.type === 'Point') ponto = geometria.coordinates
      else if (geometria.type === 'MultiPoint') ponto = geometria.coordinates[0]
      else if (geometria.type === 'Polygon') ponto = geometria.coordinates[0][0]
      else if (geometria.type === 'MultiPolygon') ponto = geometria.coordinates[0][0][0]
      else if (geometria.type === 'LineString') ponto = geometria.coordinates[0]
      if (!ponto) return null
      const p = mapa.project(ponto)
      return [Math.round(p.x), Math.round(p.y)]
    } catch {
      return null
    }
  }

  const instancias = []
  for (const f of features) {
    const camada = mapa.getLayer(f.layer.id)
    const texto = norm(textoDe(camada, f.properties || {}))
    if (!texto) continue
    const ancora = ancoraDe(f.geometry)
    // 4. fora da tela não conta
    if (ancora) {
      const [x, y] = ancora
      if (x < 0 || y < 0 || x > viewport.largura || y > viewport.altura) continue
    }
    instancias.push({
      texto,
      camada: f.layer.id,
      // 3. mesma âncora (±8 px) = a MESMA instância desenhada uma vez
      chave: `${texto.toLowerCase()}|${f.layer.id}|${ancora ? `${Math.round(ancora[0] / 8)}:${Math.round(ancora[1] / 8)}` : 'sem-ancora'}`,
      ancora,
    })
  }

  const unicas = new Map()
  for (const i of instancias) if (!unicas.has(i.chave)) unicas.set(i.chave, i)
  const visiveis = [...unicas.values()]

  // Agrupa por texto (sem caixa): o mesmo nome em 2 instâncias = duplicata
  const grupos = new Map()
  for (const v of visiveis) {
    const chave = v.texto.toLowerCase()
    if (!grupos.has(chave)) grupos.set(chave, { texto: v.texto, instancias: [], camadas: new Set() })
    const g = grupos.get(chave)
    g.instancias.push(v)
    g.camadas.add(v.camada)
  }

  const lista = [...grupos.values()]
    .map((g) => ({
      texto: g.texto,
      ocorrencias: g.instancias.length,
      camadas: [...g.camadas],
      ancoras: g.instancias.map((i) => i.ancora),
    }))
    .sort((a, b) => b.ocorrencias - a.ocorrencias || a.texto.localeCompare(b.texto))

  const alvo = lista.find((i) => i.texto.toLowerCase() === norm(cidadeAlvo).toLowerCase()) ?? null

  const ocultas = simbolos
    .filter((l) => (mapa.getLayoutProperty(l.id, 'visibility') ?? 'visible') === 'none')
    .map((l) => ({ id: l.id, sourceLayer: l['source-layer'] ?? null }))

  const debug = window.__mapaDebug || {}
  return {
    zoom: Number(zoom.toFixed(2)),
    centro: [Number(mapa.getCenter().lng.toFixed(3)), Number(mapa.getCenter().lat.toFixed(3))],
    cidade: alvo?.texto ?? cidadeAlvo,
    ocorrencias: alvo?.ocorrencias ?? 0,
    fontes: alvo?.camadas ?? [],
    ancoras: alvo?.ancoras ?? [],
    duplicados: lista.filter((i) => i.ocorrencias > 1),
    nomesDistintos: lista.length,
    camadasSimboloAtivas: ativas.map((l) => l.id),
    placeOcultas: ocultas.filter((o) => /place/.test(String(o.sourceLayer))).map((o) => o.id),
    featuresZonas: debug.featuresZonas ?? null,
    featuresMunicipios: debug.featuresMunicipios ?? null,
    featuresLocais: debug.featuresLocais ?? null,
    featuresLocaisPontos: debug.featuresLocaisPontos ?? null,
    locaisNoMunicipio: debug.locaisNoMunicipio ?? null,
    prediosDesenhados: debug.prediosDesenhados ?? null,
    modoPredios: debug.modoPredios ?? null,
  }
}

async function principal() {
  const { base, out, prefixo, resumo, drill } = argumentos(process.argv.slice(2))
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

  const itens = []
  const drillItens = []
  const falhas = []

  const esperar = async (pagina, alvo, zoom) => {
    await pagina.evaluate(
      ({ centro, z }) => window.__mapa.jumpTo({ center: centro, zoom: z, bearing: 0, pitch: 0 }),
      { centro: alvo.centro, z: zoom },
    )
    // Duas passadas: a primeira assenta os tiles do basemap, a segunda deixa o
    // handler de zoom/moveend reaplicar a alternância de rótulos.
    await pagina.waitForTimeout(2500)
    await pagina.evaluate(
      ({ centro, z }) => window.__mapa.jumpTo({ center: centro, zoom: z, bearing: 0, pitch: 0 }),
      { centro: alvo.centro, z: zoom },
    )
    await pagina.waitForTimeout(2500)
  }

  for (const viewport of VIEWPORTS) {
    const contexto = await navegador.newContext({
      viewport: { width: viewport.largura, height: viewport.altura },
      hasTouch: viewport.toque,
      deviceScaleFactor: 1,
    })

    for (const alvo of UFS) {
      const pagina = await contexto.newPage()
      let errosConsole = []
      let requestsFalhos = []
      pagina.on('console', (m) => {
        if (m.type() === 'error') errosConsole.push(m.text())
      })
      pagina.on('pageerror', (e) => errosConsole.push(`pageerror: ${e.message}`))
      pagina.on('response', (r) => {
        if (r.status() >= 400) requestsFalhos.push(`${r.status()} ${r.url()}`)
      })

      await pagina.goto(`${base}/mapa?uf=${alvo.uf}`, { waitUntil: 'domcontentloaded' })
      await pagina.waitForFunction(
        () => Boolean(window.__mapa) && window.__mapa.loaded(),
        null,
        { timeout: 60000 },
      )

      for (const z of ZOOMS) {
        await esperar(pagina, alvo, z)
        const dados = await pagina.evaluate(coletar, {
          cidadeAlvo: alvo.cidade,
          viewport: { largura: viewport.largura, altura: viewport.altura },
        })
        const print = `${out}/${prefixo}_${alvo.uf}_${viewport.nome}_z${zTexto(z)}.png`
        await pagina.screenshot({ path: print })

        const item = {
          z: Number(z.toFixed(1)),
          cidade: alvo.cidade,
          ocorrencias: dados.ocorrencias ?? 0,
          uf: alvo.uf,
          viewport: viewport.nome,
          zoomMedido: dados.zoom ?? null,
          fontes: dados.fontes ?? [],
          ancoras: dados.ancoras ?? [],
          duplicadosNoQuadro: (dados.duplicados ?? []).map((d) => ({
            texto: d.texto,
            ocorrencias: d.ocorrencias,
            camadas: d.camadas,
          })),
          nomesDistintos: dados.nomesDistintos ?? null,
          featuresZonas: dados.featuresZonas,
          featuresMunicipios: dados.featuresMunicipios,
          featuresLocais: dados.featuresLocais,
          featuresLocaisPontos: dados.featuresLocaisPontos,
          placeOcultas: dados.placeOcultas ?? [],
          consoleErros: errosConsole.length,
          requestsFalhos: requestsFalhos.length,
          print,
          erro: dados.erro ?? null,
        }
        itens.push(item)

        console.log(
          `[${alvo.uf}/${viewport.nome}/z${item.z}] zoom=${item.zoomMedido} nomes=${item.nomesDistintos} ` +
            `duplicados=${item.duplicadosNoQuadro.length} zonas=${item.featuresZonas} municipios=${item.featuresMunicipios}`,
        )
        console.log(
          `  ${item.cidade}: ocorrencias=${item.ocorrencias} fontes=${JSON.stringify(item.fontes)} ancoras=${JSON.stringify(item.ancoras)}`,
        )
        console.log(`  place ocultas: ${item.placeOcultas.length ? item.placeOcultas.join(', ') : '-'}`)
        console.log(`  print: ${print}`)

        if (dados.erro) falhas.push(`${alvo.uf}/${viewport.nome}/z${item.z}: ${dados.erro}`)
        if (item.ocorrencias !== 1) {
          falhas.push(`${alvo.uf}/${viewport.nome}/z${item.z}: ${item.cidade} com ${item.ocorrencias} ocorrencia(s)`)
        }
        for (const d of item.duplicadosNoQuadro) {
          console.log(`  DUPLICADO "${d.texto}" ocorrencias=${d.ocorrencias} -> ${d.camadas.join(' + ')}`)
        }
        if (item.consoleErros) {
          console.log(`  console: ${errosConsole.length} erro(s): ${errosConsole.slice(0, 3).join(' | ')}`)
          falhas.push(`${alvo.uf}/${viewport.nome}/z${item.z}: console ${errosConsole.length}`)
        } else {
          console.log('  console: limpo')
        }
        if (item.requestsFalhos) {
          console.log(`  requests >=400: ${requestsFalhos.slice(0, 3).join(' | ')}`)
          falhas.push(`${alvo.uf}/${viewport.nome}/z${item.z}: requests ${requestsFalhos.length}`)
        }
        errosConsole = []
        requestsFalhos = []
      }

      // Drill no município: prova que zonas e locais/pontos continuam
      // desenhando depois da alternância de rótulos (não zeraram).
      if (drill !== 'nao') {
        await pagina.goto(`${base}/mapa?uf=${alvo.uf}&m=${alvo.m}`, { waitUntil: 'domcontentloaded' })
        await pagina.waitForFunction(
          () => Boolean(window.__mapa) && window.__mapa.loaded(),
          null,
          { timeout: 60000 },
        )
        await esperar(pagina, alvo, 10.5)
        const dados = await pagina.evaluate(coletar, {
          cidadeAlvo: alvo.cidade,
          viewport: { largura: viewport.largura, altura: viewport.altura },
        })
        const print = `${out}/${prefixo}_drill_${alvo.uf}_${viewport.nome}_z10.5.png`
        await pagina.screenshot({ path: print })
        const item = {
          z: 10.5,
          cidade: alvo.cidade,
          uf: alvo.uf,
          viewport: viewport.nome,
          modo: 'drill-municipio',
          ocorrencias: dados.ocorrencias ?? 0,
          fontes: dados.fontes ?? [],
          featuresZonas: dados.featuresZonas,
          featuresLocais: dados.featuresLocais,
          featuresLocaisPontos: dados.featuresLocaisPontos,
          locaisNoMunicipio: dados.locaisNoMunicipio,
          prediosDesenhados: dados.prediosDesenhados,
          modoPredios: dados.modoPredios,
          consoleErros: errosConsole.length,
          requestsFalhos: requestsFalhos.length,
          print,
        }
        drillItens.push(item)
        console.log(
          `[drill ${alvo.uf}/${viewport.nome}] zonas=${item.featuresZonas} locais=${item.featuresLocais} ` +
            `pontos=${item.featuresLocaisPontos} predios=${item.prediosDesenhados}(${item.modoPredios}) ` +
            `${item.cidade}=${item.ocorrencias}`,
        )
        console.log(`  print: ${print}`)
        if (!item.featuresZonas) falhas.push(`drill ${alvo.uf}/${viewport.nome}: featuresZonas zerou`)
        if (!item.featuresLocais && !item.featuresLocaisPontos) {
          falhas.push(`drill ${alvo.uf}/${viewport.nome}: locais e pontos zeraram`)
        }
        errosConsole = []
        requestsFalhos = []
      }

      await pagina.close()
    }
    await contexto.close()
  }

  await navegador.close()

  const saida = {
    gerado: new Date().toISOString(),
    base,
    criterio: 'ocorrencias da cidade-alvo == 1 em z8, z9.5 e z10.5 (desktop e mobile)',
    zooms: ZOOMS,
    itens,
    drill: drillItens,
    falhas,
    ok: falhas.length === 0,
  }
  await writeFile(resumo, JSON.stringify(saida, null, 2))
  console.log('')
  console.log(`resumo: ${resumo}`)
  console.log(`cenarios=${itens.length} drill=${drillItens.length} falhas=${falhas.length}`)
  if (falhas.length) {
    console.log('FALHOU')
    for (const f of falhas) console.log(`  - ${f}`)
    process.exitCode = 1
  } else {
    console.log('OK: 1 rótulo por cidade em z8, z9.5 e z10.5 (desktop e mobile)')
  }
}

principal().catch((erro) => {
  console.error(erro)
  process.exitCode = 1
})
