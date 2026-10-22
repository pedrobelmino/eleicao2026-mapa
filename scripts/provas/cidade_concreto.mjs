#!/usr/bin/env node
// Prova do segmento de CONCRETO no topo dos prédios (item 10).
//
// Só faz sentido na instância de TESTE com apuração simulada, porque os dados
// oficiais do 1º turno estão 100% apurados:
//
//   APURACAO_DEMO=CE=78 docker compose -p eleicao2026-teste \
//     -f compose.yaml -f compose.teste.yaml up -d --build
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/cidade_concreto.mjs --base http://127.0.0.1:8100
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop', largura: 1440, altura: 900 },
  { nome: 'mobile', largura: 390, altura: 844 },
]

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8100', out: '_provas' }
  for (let i = 0; i < argv.length; i += 1) {
    const [chave, naLinha] = argv[i].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = naLinha ?? argv[i + 1]
    if (naLinha == null) i += 1
  }
  opcoes.base = opcoes.base.replace(/\/+$/, '')
  return opcoes
}

async function principal() {
  const { base, out } = lerArgumentos(process.argv.slice(2))
  await mkdir(out, { recursive: true })

  // A própria API primeiro: prova que o denominador é o total de seções do
  // dump e que o corte do demo não inventa seção.
  const resposta = await fetch(
    `${base}/api/uf/CE/locais?cd=13897`,
    { headers: { Accept: 'application/json' } },
  )
  const corpo = await resposta.json()
  const locais = Array.isArray(corpo.locais) ? corpo.locais : []
  const esperadas = locais.reduce((soma, l) => soma + Number(l.secoes_esperadas || 0), 0)
  const apuradas = locais.reduce((soma, l) => soma + Number(l.secoes_apuradas || 0), 0)
  const parciais = locais.filter((l) => Number(l.pct_apurado) < 100)
  const api = {
    status: resposta.status,
    locais: locais.length,
    secoes_esperadas: esperadas,
    secoes_apuradas: apuradas,
    pct_global: Number(((apuradas / esperadas) * 100).toFixed(2)),
    locais_parciais: parciais.length,
    exemplo: parciais[0]
      ? {
          nr_local: parciais[0].nr_local,
          pct_apurado: parciais[0].pct_apurado,
          secoes_apuradas: parciais[0].secoes_apuradas,
          secoes_esperadas: parciais[0].secoes_esperadas,
        }
      : null,
  }
  console.log(`api=${JSON.stringify(api)}`)

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })

  const medidas = []
  let falhou = false
  try {
    for (const viewport of VIEWPORTS) {
      const rotulo = `[concreto][${viewport.nome}]`
      const contexto = await browser.newContext({
        viewport: { width: viewport.largura, height: viewport.altura },
        deviceScaleFactor: 1,
      })
      const page = await contexto.newPage()
      const erros = []
      page.on('console', (m) => {
        if (m.type() === 'error') erros.push(m.text())
      })
      page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`))

      await page.goto(`${base}/mapa?uf=CE&m=13897&z=12.2`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      })
      await page.waitForFunction(
        () => Number(window.__mapaDebug?.predios || 0) > 0,
        null,
        { timeout: 45000 },
      )
      await page.waitForTimeout(4500)
      await page.evaluate(
        () =>
          new Promise((resolver) => {
            const mapa = window.__mapa
            let pronto = false
            const fim = () => {
              if (pronto) return
              pronto = true
              resolver(true)
            }
            mapa.once('idle', fim)
            mapa.resize()
            mapa.triggerRepaint()
            setTimeout(fim, 8000)
          }),
      )
      await page.waitForTimeout(600)

      const debug = await page.evaluate(() => window.__mapaDebug || null)
      const arquivo = path.join(
        out,
        `item10_concreto_demo_${viewport.nome}_${viewport.largura}x${viewport.altura}.png`,
      )
      await page.screenshot({ path: arquivo })
      console.log(`${rotulo} print=${arquivo}`)
      console.log(`${rotulo} debug=${JSON.stringify(debug)}`)
      if (erros.length) console.log(`${rotulo} console.errors=${JSON.stringify(erros)}`)

      if (Number(debug?.prediosConcreto || 0) < 1) {
        console.log(`${rotulo} FALHA=nenhum prisma de concreto desenhado`)
        falhou = true
      }
      if (erros.length) falhou = true
      medidas.push({ viewport: viewport.nome, print: arquivo, debug, erros })
      await page.close()
      await contexto.close()
    }
  } finally {
    await browser.close()
  }

  await writeFile(
    path.join(out, 'item10_concreto.json'),
    JSON.stringify({ api, medidas }, null, 2),
  )
  if (falhou) {
    console.error('PROVA FALHOU: concreto não apareceu ou houve erro de console.')
    process.exitCode = 1
  } else {
    console.log('PROVA OK: prédios com topo em concreto na apuração simulada.')
  }
}

principal().catch((erro) => {
  console.error('PROVA FALHOU ao executar o Playwright:', erro)
  process.exitCode = 1
})
