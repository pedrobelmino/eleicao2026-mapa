#!/usr/bin/env node
// Prova do REPLAY e do painel de MARGENS.
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/replay.mjs --base http://127.0.0.1:8100 --out _provas
//
// O que é provado, e não "deve funcionar":
//   1. o replay em DOIS instantes (≈35% e ≈80% apurado): o handle
//      window.__replayDebug diz quantas UFs a camada `ufs-fill` está pintando
//      como fechadas — o número tem de CRESCER do primeiro para o segundo;
//   2. o mapa de calor de margem: a expressão de fill-color muda (interpolate)
//      e o card "De onde está ganhando" traz margem em votos/pontos e os
//      municípios decisivos;
//   3. console limpo: nenhum erro de console/pageerror e nenhuma resposta >=400.
//
// Imprime uma linha JSON por print (para virar prova no ROADMAP) e um resumo.
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop_1440x900', largura: 1440, altura: 900 },
  { nome: 'mobile_390x844', largura: 390, altura: 844 },
]

const INSTANTES = [35, 80]

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

function argumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8100', out: '_provas', vp: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const [chave, mesmo] = argv[i].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = mesmo ?? argv[i + 1]
    if (mesmo == null) i += 1
  }
  opcoes.base = opcoes.base.replace(/\/+$/, '')
  return opcoes
}

// Índice do frame cujo pct_apurado está mais perto do alvo. O replay amostra
// a série real do TSE em até 120 frames, então o alvo é aproximado.
function frameMaisProximo(frames, alvo) {
  let melhor = 0
  let distancia = Infinity
  frames.forEach((frame, indice) => {
    const d = Math.abs(Number(frame.pct_apurado) - alvo)
    if (d < distancia) {
      distancia = d
      melhor = indice
    }
  })
  return melhor
}

async function esperarReplay(pagina, indice) {
  await pagina.waitForFunction(
    (alvo) =>
      window.__mapa &&
      window.__mapa.loaded() &&
      window.__replayDebug &&
      window.__replayDebug.modo === 'replay' &&
      window.__replayDebug.frame === alvo,
    indice,
    { timeout: 45000 },
  )
  // A transição de cor das UFs é de 900 ms: o print tem de vir depois dela.
  await dormir(1300)
}

async function esperarMargens(pagina) {
  await pagina.waitForFunction(
    () =>
      window.__mapa &&
      window.__mapa.loaded() &&
      window.__replayDebug &&
      window.__replayDebug.modo === 'margem' &&
      document.querySelector('[data-prova="margem-votos"]'),
    { timeout: 45000 },
  )
  await dormir(1200)
}

async function medir(pagina) {
  return pagina.evaluate(() => {
    const debug = window.__replayDebug || {}
    const mapa = window.__mapa
    const expressao = mapa?.getPaintProperty?.('ufs-fill', 'fill-color')
    const cor = Array.isArray(expressao) ? expressao[0] : String(expressao)
    const texto = (seletor) =>
      document.querySelector(seletor)?.textContent?.trim() || null
    const card = document.querySelector('.margens-card')
    const visivel = card && card.getBoundingClientRect().width > 0
    return {
      ...debug,
      expressao: cor,
      pct_barra: texto('[data-prova="replay-pct"]'),
      relogio: texto('[data-prova="replay-relogio"]'),
      fechadas_barra: texto('[data-prova="replay-fechadas"]'),
      margem_votos: texto('[data-prova="margem-votos"]'),
      margem_pontos: texto('[data-prova="margem-pontos"]'),
      card_visivel: Boolean(visivel),
      card_caixa: visivel
        ? (() => {
            const c = card.getBoundingClientRect()
            return `${Math.round(c.width)}x${Math.round(c.height)}`
          })()
        : null,
      decisivos: [...document.querySelectorAll('.margem-municipio .margem-nome')]
        .slice(0, 5)
        .map((el) => el.textContent.trim()),
      regioes: [...document.querySelectorAll('.margem-linha .margem-nome')].map(
        (el) => el.textContent.trim(),
      ),
    }
  })
}

async function principal() {
  const opcoes = argumentos(process.argv.slice(2))
  await mkdir(opcoes.out, { recursive: true })

  const resposta = await fetch(`${opcoes.base}/api/replay?modo=2022`)
  if (!resposta.ok) throw new Error(`/api/replay respondeu ${resposta.status}`)
  const replay = await resposta.json()
  if (!replay.disponivel) throw new Error(`replay indisponível: ${replay.nota}`)
  const alvos = INSTANTES.map((pct) => ({
    pct,
    indice: frameMaisProximo(replay.frames, pct),
  }))
  console.log(
    JSON.stringify({
      tipo: 'serie',
      frames: replay.frames.length,
      alvos: alvos.map((a) => ({
        pedido: a.pct,
        indice: a.indice,
        pct: replay.frames[a.indice].pct_apurado,
        em: replay.frames[a.indice].em,
      })),
    }),
  )

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })

  const viewports = opcoes.vp
    ? VIEWPORTS.filter((v) => v.nome.startsWith(opcoes.vp))
    : VIEWPORTS

  const problemas = []
  const medicoes = {}

  for (const vp of viewports) {
    const contexto = await browser.newContext({
      viewport: { width: vp.largura, height: vp.altura },
      deviceScaleFactor: 1,
    })
    const pagina = await contexto.newPage()

    const erros = []
    const respostasRuins = []
    pagina.on('console', (msg) => {
      if (msg.type() === 'error') erros.push(msg.text())
    })
    pagina.on('pageerror', (erro) => erros.push(`pageerror: ${erro.message}`))
    pagina.on('response', (resp) => {
      if (resp.status() >= 400) respostasRuins.push(`${resp.status()} ${resp.url()}`)
    })

    const fechadas = []
    for (const alvo of alvos) {
      // ?replay é 1-based: 1 abre no primeiro frame.
      const url = `${opcoes.base}/mapa?replay=${alvo.indice + 1}`
      await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await esperarReplay(pagina, alvo.indice)
      const dados = await medir(pagina)
      fechadas.push(dados.ufs_fechadas || 0)

      const arquivo = path.join(
        opcoes.out,
        `replay_${String(alvo.pct).padStart(2, '0')}_${vp.nome}.png`,
      )
      await pagina.screenshot({ path: arquivo })
      console.log(
        JSON.stringify({
          tipo: 'replay',
          viewport: vp.nome,
          pedido_pct: alvo.pct,
          pct: dados.pct_apurado,
          frame: dados.frame,
          pct_barra: dados.pct_barra,
          relogio: dados.relogio,
          fechadas_barra: dados.fechadas_barra,
          ufs_fechadas: dados.ufs_fechadas,
          ufs_total: dados.ufs_total,
          expressao: dados.expressao,
          arquivo,
        }),
      )

      if (!dados.ufs_fechadas || dados.ufs_fechadas < 1) {
        problemas.push(`${vp.nome} ${alvo.pct}%: nenhuma UF fechada (esperado ao menos 1)`)
      }
      if (dados.expressao !== 'case') {
        problemas.push(
          `${vp.nome} ${alvo.pct}%: fill-color do replay não é a expressão por feature-state (${dados.expressao})`,
        )
      }
    }

    if (!(fechadas[1] > fechadas[0])) {
      problemas.push(
        `${vp.nome}: UFs fechadas não cresceram (${fechadas[0]} -> ${fechadas[1]})`,
      )
    }

    // Mapa de calor de margem + card "De onde está ganhando".
    await pagina.goto(`${opcoes.base}/mapa?margem=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    })
    await esperarMargens(pagina)
    const margens = await medir(pagina)
    medicoes[vp.nome] = margens

    const arquivoMargens = path.join(opcoes.out, `margens_${vp.nome}.png`)
    await pagina.screenshot({ path: arquivoMargens })
    console.log(
      JSON.stringify({
        tipo: 'margens',
        viewport: vp.nome,
        expressao: margens.expressao,
        margem_votos: margens.margem_votos,
        margem_pontos: margens.margem_pontos,
        card_visivel: margens.card_visivel,
        card_caixa: margens.card_caixa,
        regioes: margens.regioes,
        decisivos: margens.decisivos,
        arquivo: arquivoMargens,
      }),
    )

    if (margens.expressao !== 'interpolate') {
      problemas.push(
        `${vp.nome}: mapa de calor não aplicou a rampa de margem (${margens.expressao})`,
      )
    }
    if (!margens.card_visivel) {
      problemas.push(`${vp.nome}: card de margens não está visível`)
    }
    if (!margens.margem_votos || !margens.margem_pontos) {
      problemas.push(`${vp.nome}: card sem margem em votos/pontos`)
    }
    if (margens.decisivos.length < 3) {
      problemas.push(`${vp.nome}: menos de 3 municípios decisivos no card`)
    }

    const errosLimpos = [...new Set(erros)]
    const ruinsLimpos = [...new Set(respostasRuins)]
    if (errosLimpos.length > 0) {
      problemas.push(`${vp.nome}: console com ${errosLimpos.length} erro(s): ${errosLimpos.join(' | ')}`)
    }
    if (ruinsLimpos.length > 0) {
      problemas.push(`${vp.nome}: respostas >=400: ${ruinsLimpos.join(' | ')}`)
    }
    console.log(
      JSON.stringify({
        tipo: 'console',
        viewport: vp.nome,
        erros: errosLimpos,
        respostas_ruins: ruinsLimpos,
      }),
    )

    await contexto.close()
  }

  await browser.close()

  console.log(
    JSON.stringify({
      tipo: 'resumo',
      problemas,
      ok: problemas.length === 0,
    }),
  )
  if (problemas.length > 0) process.exitCode = 1
}

principal().catch((erro) => {
  console.error(`falha na prova: ${erro.message}`)
  process.exitCode = 1
})
