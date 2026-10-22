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
]

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
  const requisicoesFalhas = []
  let scrollHorizontal = false
  let debug = null
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
    requisicoesFalhas.push(
      `${requisicao.url()} (${requisicao.failure()?.errorText || 'falhou'})`,
    )
  })

  const zoomCenario =
    viewport.nome === 'mobile' && cenario.zoomMobile
      ? cenario.zoomMobile
      : cenario.zoom
  const url = `${base}/mapa?uf=CE&z=${zoomCenario}`
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
    `${rotulo} scrollHorizontal=${scrollHorizontal ? 'SIM' : 'nao'}`,
  )
  imprimirLista(rotulo, 'console.errors', errosConsole, 'nenhum')
  imprimirLista(rotulo, 'requests>=400', requisicoesComErro, 'nenhum')
  imprimirLista(rotulo, 'requests falhas', requisicoesFalhas, 'nenhuma')
  if (falha) console.log(`${rotulo} FALHA=${falha}`)
  console.log('')

  const falhou =
    Boolean(falha) ||
    errosConsole.length > 0 ||
    requisicoesComErro.length > 0 ||
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
    console.error('PROVA FALHOU: veja console.errors, requests>=400 ou scroll horizontal acima.')
    process.exitCode = 1
  } else {
    console.log('PROVA OK: nenhum erro de console, request >= 400 ou scroll horizontal.')
  }
}

principal().catch((erro) => {
  console.error('PROVA FALHOU ao executar o Playwright:', erro)
  process.exitCode = 1
})
