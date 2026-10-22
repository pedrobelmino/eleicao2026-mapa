#!/usr/bin/env node
// Prova visual do drill-down UF -> município e dos prismas 3D por zona.
// Roda com NODE_PATH apontando para os node_modules do agente:
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/captura.mjs --base http://127.0.0.1:8100 \
//     --out _provas --prefix item3
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

// ESM não consulta NODE_PATH; createRequire mantém o comando de prova simples.
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop', largura: 1440, altura: 900 },
  { nome: 'mobile', largura: 390, altura: 844 },
]

const CENARIOS = [
  {
    nome: 'estado',
    zoom: '6.3',
    // No celular a faixa visível acima do bottom sheet é baixa: 6.3 corta o
    // estado inteiro. 5.9 mantém os prismas acesos e o Ceará em quadro.
    zoomMobile: '5.9',
    espera: 'featuresZonas',
    descricao: 'prismas das zonas',
  },
  {
    nome: 'municipio',
    zoom: '8.6',
    espera: 'featuresMunicipios',
    descricao: 'preenchimento municipal',
  },
  {
    // Nível urna: ?m=<cd_tse> abre Fortaleza, ?z=11 passa do ZOOM_LOCAL (9.2)
    // e a camada de pontos/prismas dos locais de votação entra em cena.
    nome: 'local',
    municipio: '13897',
    zoom: '11',
    espera: 'camadasLocais',
    descricao: 'pontos dos locais de votação',
  },
  {
    // Abaixo do clusterMaxZoom (12) os locais próximos viram bolhas com o
    // número de locais agrupados.
    nome: 'local_cluster',
    municipio: '13897',
    zoom: '10.2',
    espera: 'camadasLocais',
    descricao: 'clusters de locais de votação',
  },
  {
    // Acima do clusterMaxZoom todos os locais aparecem como ícones de urna.
    nome: 'local_zoom',
    municipio: '13897',
    zoom: '13',
    espera: 'camadasLocais',
    descricao: 'ícones de urna no zoom de detalhe',
  },
  {
    // O mesmo nível, com o detalhe aberto: clique real num ponto de local.
    nome: 'local_detalhe',
    municipio: '13897',
    zoom: '13',
    espera: 'camadasLocais',
    clicarLocal: true,
    descricao: 'detalhe do local (seções/urnas)',
  },
]

function urlDoCenario(base, cenario, zoom) {
  const municipio = cenario.municipio ? `&m=${cenario.municipio}` : ''
  return `${base}/mapa?uf=CE${municipio}&z=${zoom}`
}

// Escolhe um local de votação desenhado na parte visível do mapa e devolve as
// coordenadas de tela para o clique real (no celular o bottom sheet cobre 72%
// da tela, então o ponto tem que estar na faixa de cima).
async function pontoDeLocal() {
  const mapa = window.__mapa
  if (!mapa) return null
  const largura = window.innerWidth
  const altura = window.innerHeight
  const mobile = largura <= 820
  const yMaximo = mobile ? Math.round(altura * 0.24) : altura - 80

  const escolher = (camada) => {
    let melhor = null
    let features = []
    try {
      features = mapa.queryRenderedFeatures({ layers: [camada] })
    } catch {
      return null
    }
    for (const feature of features) {
      const coordenadas = feature.geometry?.coordinates
      if (!coordenadas) continue
      const ponto = mapa.project(coordenadas)
      if (ponto.x < 24 || ponto.x > largura - 24) continue
      if (ponto.y < 70 || ponto.y > yMaximo) continue
      const total = Number(feature.properties?.total) || 0
      if (!melhor || total > melhor.total) {
        melhor = {
          x: Math.round(ponto.x),
          y: Math.round(ponto.y),
          total,
          nr_local: feature.properties?.nr_local,
        }
      }
    }
    return melhor
  }

  // O hit é o alvo preferido (raio maior); se a colocação do símbolo não
  // renderizou nada nele, o ícone do ponto ainda serve para o clique real.
  const naFaixa = escolher('locais-hit') || escolher('locais-ponto')
  if (naFaixa) return naFaixa

  // Fallback (celular): nenhum local caiu na faixa visível acima do bottom
  // sheet. Escolhe o local com mais votos entre os features renderizados,
  // centraliza a câmera nele sem mudar o zoom e espera o mapa ficar idle.
  // Só depois de o reposicionamento assentar devolve a coordenada de tela,
  // para o clique real do Playwright cair no ícone.
  let alvo = null
  for (const camada of ['locais-hit', 'locais-ponto']) {
    let features = []
    try {
      features = mapa.queryRenderedFeatures({ layers: [camada] })
    } catch {
      continue
    }
    for (const feature of features) {
      const coordenadas = feature.geometry?.coordinates
      if (!coordenadas) continue
      const total = Number(feature.properties?.total) || 0
      if (!alvo || total > alvo.total) {
        alvo = {
          coordenadas,
          total,
          nr_local: feature.properties?.nr_local,
        }
      }
    }
  }
  if (!alvo) return null

  mapa.easeTo({
    center: alvo.coordenadas,
    zoom: mapa.getZoom(),
    duration: 0,
  })
  await new Promise((resolver) => {
    let concluido = false
    const fim = () => {
      if (concluido) return
      concluido = true
      mapa.off('idle', fim)
      resolver()
    }
    mapa.once('idle', fim)
    mapa.triggerRepaint()
    // Em GPU de software o idle pode demorar; não deixa a prova pendurada.
    setTimeout(fim, 6000)
  })

  const ponto = mapa.project(alvo.coordenadas)
  return {
    x: Math.round(ponto.x),
    y: Math.round(ponto.y),
    total: alvo.total,
    nr_local: alvo.nr_local,
  }
}

function lerArgumentos(argv) {
  const opcoes = {
    base: 'http://127.0.0.1:8100',
    out: '_provas',
    prefix: 'captura',
  }

  for (let indice = 0; indice < argv.length; indice += 1) {
    const argumento = argv[indice]
    const [chave, valorNaMesmaLinha] = argumento.split('=')
    if (!chave.startsWith('--')) continue

    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = valorNaMesmaLinha ?? argv[indice + 1]
    if (valorNaMesmaLinha == null) indice += 1
  }

  opcoes.base = opcoes.base.replace(/\/+$/, '')
  return opcoes
}

function imprimirLista(prefixo, rotulo, itens, vazio) {
  if (itens.length === 0) {
    console.log(`${prefixo} ${rotulo}: ${vazio}`)
    return
  }
  console.log(`${prefixo} ${rotulo}: ${itens.length}`)
  for (const item of itens) console.log(`${prefixo}   - ${item}`)
}

async function capturarCenario(browser, base, out, prefix, viewport, cenario) {
  const rotulo = `[${cenario.nome}][${viewport.nome}]`
  const context = await browser.newContext({
    viewport: { width: viewport.largura, height: viewport.altura },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()

  const errosConsole = []
  const requisicoesComErro = []
  const requisicoesCanceladas = []
  const requisicoesFalhas = []
  let scrollHorizontal = false
  let debug = null
  let clique = null
  let cartao = null
  let falha = null

  page.on('console', (mensagem) => {
    if (mensagem.type() === 'error') errosConsole.push(mensagem.text())
  })
  page.on('pageerror', (erro) => {
    errosConsole.push(`pageerror: ${erro.message}`)
  })
  page.on('response', (resposta) => {
    if (resposta.status() >= 400) {
      requisicoesComErro.push(`${resposta.status()} ${resposta.url()}`)
    }
  })
  page.on('requestfailed', (requisicao) => {
    const url = requisicao.url()
    const erro = requisicao.failure()?.errorText || 'falhou'
    const item = `${url} (${erro})`
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      // URL relativa/inválida não é tile externo do CARTO.
    }
    const tileCarto =
      host === 'basemaps.cartocdn.com' ||
      host.endsWith('.basemaps.cartocdn.com')
    // O MapLibre aborta tiles do CARTO ao mover a câmera: é cancelamento
    // esperado, não defeito do app. Só os demais requestfailed reprovam.
    if (erro === 'net::ERR_ABORTED' && tileCarto) {
      requisicoesCanceladas.push(item)
    } else {
      requisicoesFalhas.push(item)
    }
  })

  const zoomCenario =
    viewport.nome === 'mobile' && cenario.zoomMobile
      ? cenario.zoomMobile
      : cenario.zoom
  const url = urlDoCenario(base, cenario, zoomCenario)
  const arquivo = `${prefix}_${cenario.nome}_${viewport.nome}_${viewport.largura}x${viewport.altura}.png`
  const destino = path.join(out, arquivo)

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForSelector('canvas.maplibregl-canvas, canvas', {
      timeout: 25000,
    })
    await page.waitForFunction(
      (campo) =>
        Boolean(window.__mapaDebug) &&
        Number(window.__mapaDebug[campo] || 0) > 0,
      cenario.espera,
      { timeout: 25000 },
    )
    // Tiles, glyphs e o fade de zoom precisam de um tempo extra.
    await page.waitForTimeout(3000)

    // Em GPU de software o canvas pode ficar sem frame depois do fitBounds +
    // pitch: força resize e repaint e espera o mapa ficar ocioso antes do print.
    await page.evaluate(
      () =>
        new Promise((resolver) => {
          const mapa = window.__mapa
          if (!mapa) {
            resolver(false)
            return
          }
          let concluido = false
          const fim = () => {
            if (concluido) return
            concluido = true
            resolver(true)
          }
          mapa.once('idle', fim)
          mapa.resize()
          mapa.triggerRepaint()
          setTimeout(fim, 6000)
        }),
    )
    await page.waitForTimeout(1200)

    debug = await page.evaluate(() => window.__mapaDebug || null)

    if (cenario.clicarLocal) {
      const alvo = await page.evaluate(pontoDeLocal)
      if (!alvo) throw new Error('nenhum ponto de local visível para clicar')
      // map.project() devolve coordenada do CONTAINER do mapa; o mouse do
      // Playwright usa coordenada de PÁGINA. O canvas começa abaixo do header
      // (medido: y=76 no desktop), então o offset é obrigatório — sem ele o
      // clique caía ~76 px acima do ícone e nenhum cartão abria.
      const caixaCanvas = await page.evaluate(() => {
        const canvas = document.querySelector('canvas.maplibregl-canvas')
        if (!canvas) return null
        const r = canvas.getBoundingClientRect()
        return { x: r.x, y: r.y }
      })
      const deslocamento = caixaCanvas || { x: 0, y: 0 }
      await page.mouse.click(
        Math.round(deslocamento.x + alvo.x),
        Math.round(deslocamento.y + alvo.y),
      )
      try {
        await page.waitForSelector('.local-card', {
          state: 'visible',
          timeout: 15000,
        })
      } catch {
        throw new Error(
          `o cartão .local-card não apareceu após o clique real no local ` +
            `nr_local=${alvo.nr_local} em (${Math.round(deslocamento.x + alvo.x)},` +
            `${Math.round(deslocamento.y + alvo.y)})`,
        )
      }
      await page.waitForTimeout(600)
      clique = { ...alvo, x: Math.round(deslocamento.x + alvo.x), y: Math.round(deslocamento.y + alvo.y) }
      cartao = await page.evaluate(() => {
        const elemento = document.querySelector('.local-card')
        if (!elemento) return null
        return {
          titulo: elemento.querySelector('.detail-title')?.textContent || '',
          lider: elemento.querySelector('.leader-copy strong')?.textContent || '',
          liderPct: elemento.querySelector('.leader-pct')?.textContent || '',
          apurado: elemento.querySelector('.local-apurado-numero')?.textContent || '',
          apuradoSecoes: elemento.querySelector('.local-apurado-secoes')?.textContent || '',
          secoes: elemento.querySelectorAll('.section-item').length,
          cabecalho: elemento.querySelector('.local-secoes h3')?.textContent || '',
          texto: elemento.innerText.replace(/\s+/g, ' ').slice(0, 260),
        }
      })
      debug = await page.evaluate(() => window.__mapaDebug || null)
    }

    scrollHorizontal = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
    await page.screenshot({ path: destino })
  } catch (erro) {
    falha = erro.message
    try {
      await page.screenshot({ path: destino })
    } catch {
      // A captura de socorro é opcional.
    }
  } finally {
    await page.close()
    await context.close()
  }

  const zoom = debug?.zoom ?? null
  console.log(`${rotulo} url=${url}`)
  console.log(`${rotulo} print=${destino} zoom=${zoom ?? '—'}`)
  console.log(
    `${rotulo} __mapaDebug=${debug ? JSON.stringify(debug) : 'null'} (${cenario.descricao})`,
  )
  console.log(
    `${rotulo} camadasLocais=${debug?.camadasLocais ?? '—'} clustersVisiveis=${debug?.clustersVisiveis ?? '—'} featuresLocaisPontos=${debug?.featuresLocaisPontos ?? '—'} featuresLocaisPrisma=${debug?.featuresLocaisPrisma ?? '—'}`,
  )
  console.log(
    `${rotulo} scrollHorizontal=${scrollHorizontal ? 'SIM' : 'nao'}`,
  )
  if (clique) {
    console.log(
      `${rotulo} clique=(${clique.x},${clique.y}) nr_local=${clique.nr_local} votos=${clique.total}`,
    )
  }
  if (cartao) {
    console.log(
      `${rotulo} card="${cartao.titulo}" lider="${cartao.lider}" liderPct="${cartao.liderPct}" secoes=${cartao.secoes} h3="${cartao.cabecalho}"`,
    )
    console.log(
      `${rotulo} card.apurado="${cartao.apurado}" card.apuradoSecoes="${cartao.apuradoSecoes}"`,
    )
    console.log(`${rotulo} card.texto=${cartao.texto}`)
    if (cartao.secoes < 1) {
      console.log(`${rotulo} FALHA=card do local sem seções`)
      falha = falha || 'card do local sem seções'
    }
  }
  imprimirLista(rotulo, 'console.errors', errosConsole, 'nenhum')
  imprimirLista(rotulo, 'requests>=400', requisicoesComErro, 'nenhum')
  imprimirLista(rotulo, 'requests canceladas', requisicoesCanceladas, 'nenhuma')
  imprimirLista(rotulo, 'requests falhas', requisicoesFalhas, 'nenhuma')
  if (falha) console.log(`${rotulo} FALHA=${falha}`)
  console.log('')

  const falhou =
    Boolean(falha) ||
    errosConsole.length > 0 ||
    requisicoesComErro.length > 0 ||
    requisicoesFalhas.length > 0 ||
    scrollHorizontal

  return falhou
}

async function principal() {
  const { base, out, prefix } = lerArgumentos(process.argv.slice(2))
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

  let falhou = false
  try {
    for (const viewport of VIEWPORTS) {
      for (const cenario of CENARIOS) {
        const resultado = await capturarCenario(
          browser,
          base,
          out,
          prefix,
          viewport,
          cenario,
        )
        if (resultado) falhou = true
      }
    }
  } finally {
    await browser.close()
  }

  if (falhou) {
    console.error(
      'PROVA FALHOU: veja console.errors, requests>=400, requests falhas ou scroll horizontal acima.',
    )
    process.exitCode = 1
  } else {
    console.log(
      'PROVA OK: nenhum erro de console, request >= 400, request falha ou scroll horizontal.',
    )
  }
}

principal().catch((erro) => {
  console.error('PROVA FALHOU ao executar o Playwright:', erro)
  process.exitCode = 1
})
