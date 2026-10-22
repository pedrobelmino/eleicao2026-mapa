#!/usr/bin/env node
// Prova da regra do concreto no nível macro: a UF com apuração em andamento
// (APURACAO_DEMO=CE=78 na stack de teste) tem de ficar em cinza-concreto,
// enquanto as UFs com 100% das seções apuradas mantêm a cor do líder.
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/macro_concreto.mjs --base http://127.0.0.1:8100
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

function argumentos(argv) {
  const saida = { base: 'http://127.0.0.1:8100', out: '_provas/mapa-ui', prefixo: 'concreto' }
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

async function principal() {
  const { base, out, prefixo } = argumentos(process.argv.slice(2))
  await mkdir(out, { recursive: true })

  const dados = await fetch(`${base}/api/ufs.geojson`).then((r) => r.json())
  const amostra = dados.features
    .filter((f) => ['CE', 'RR', 'SP'].includes(f.properties.uf))
    .map((f) => {
      const p = f.properties
      const fechada = Number(p.secoes_total) > 0 && p.secoes_apuradas === p.secoes_total
      return {
        uf: p.uf,
        secoes_apuradas: p.secoes_apuradas,
        secoes_total: p.secoes_total,
        pct: p.pct_apurado,
        lider: p.partido_lider,
        cor_esperada: fechada ? `cor do líder (${p.partido_lider})` : 'concreto',
      }
    })

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
  await pagina.goto(`${base}/mapa`, { waitUntil: 'domcontentloaded' })
  await pagina.waitForFunction(
    () => Boolean(window.__mapa) && window.__mapa.loaded(),
    null,
    { timeout: 45000 },
  )
  await pagina.evaluate(() => window.__mapa.jumpTo({ center: [-51.5, -14.5], zoom: 3.4, bearing: 0, pitch: 0 }))
  await pagina.waitForTimeout(2500)
  const arquivo = `${out}/${prefixo}_macro_1440x900.png`
  await pagina.screenshot({ path: arquivo })

  console.log(`url=${base}/mapa (zoom 3.4, sem UF selecionada)`)
  for (const item of amostra) {
    console.log(
      `  ${item.uf}: secoes_apuradas=${item.secoes_apuradas}/${item.secoes_total} (${item.pct}%) -> ${item.cor_esperada}`,
    )
  }
  console.log(`print=${arquivo}`)

  const semApuracao = amostra.filter((i) => i.pct < 100 && i.cor_esperada === 'concreto')
  if (semApuracao.length === 0) {
    console.log('AVISO: nenhuma UF da amostra está com apuração em andamento nesta stack')
  }

  await contexto.close()
  await browser.close()
}

principal().catch((erro) => {
  console.error('FALHOU:', erro)
  process.exitCode = 1
})
