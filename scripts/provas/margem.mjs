#!/usr/bin/env node
// Prova do ITEM 6 — visão "de onde está ganhando" (MARGEM por município).
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/margem.mjs --base http://127.0.0.1:8100 --out _provas
//
// O que é medido, e não "deve funcionar":
//   1. botão MARGEM LIGADO: n.º de features da camada de calor
//      (window.__margemDebug.featuresCalor), n.º de municípios que viraram e o
//      top-5 do card (nome + margem em votos/pontos) lidos do DOM;
//   2. os números do card batem com o backend: /api/uf/{UF}/margens conta os
//      "viraram" e ordena o top-10 por margem_votos × vv — a prova compara os
//      dois lados (API x mapa x card) e FALHA se divergirem;
//   3. botão DESLIGADO: a camada de calor sai (featuresCalor = 0, visibility
//      none) e as camadas que já existiam continuam de pé (featuresZonas e
//      featuresMunicipios não zeram);
//   4. EXCLUSIVIDADE: ligar REPLAY desliga MARGEM e vice-versa (um modo por vez);
//   5. console limpo e nenhuma resposta >=400, desktop 1440x900 e mobile
//      390x844, sem scroll horizontal no celular.
//
// Saída: `_provas/margem_resumo.json` + prints
// `_provas/margem_{CE,SP}_{desktop_1440x900,mobile_390x844}.png`. O campo
// `gerado` só é gravado no fim: se ele não estiver no JSON, a prova morreu no
// meio e o arquivo não vale.
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop_1440x900', largura: 1440, altura: 900 },
  { nome: 'mobile_390x844', largura: 390, altura: 844 },
]

const UFS = ['CE', 'SP']

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

function argumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8100', out: '_provas', uf: '', vp: '' }
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

// "210.751 votos · 14,14 pts" -> 210751 ; "1 viraram em relação a 2022" -> 1
// (o texto do card usa separador de milhar e vírgula decimal).
function numeroDoTexto(texto, sufixo) {
  if (!texto) return null
  const padrao = sufixo ? new RegExp(`([\\d.]+)\\s*${sufixo}`) : /^(\d+)/
  const achado = String(texto).match(padrao)
  if (!achado) return null
  const valor = Number(achado[1].replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(valor) ? valor : null
}

// Mede o que está na tela: debug do mapa, card, camadas que já existiam.
async function medir(pagina) {
  return pagina.evaluate(() => {
    const texto = (seletor) => {
      const el = document.querySelector(seletor)
      return el ? el.textContent.trim() : null
    }
    const margemDebug = window.__margemDebug || {}
    const mapaDebug = window.__mapaDebug || {}
    // Dois cards existem no DOM (painel lateral no desktop, bottom sheet no
    // celular). Mede-se SEMPRE o que tem caixa na tela — senão a contagem
    // dobra (foi o que a primeira passagem desta prova acusou).
    const cards = [...document.querySelectorAll('.margens-card')]
    const cardVisivel =
      cards.find((el) => {
        const caixa = el.getBoundingClientRect()
        return caixa.width > 0 && caixa.height > 0
      }) || null
    const linhas = [
      ...(cardVisivel
        ? cardVisivel.querySelectorAll('[data-prova="margem-decisivo"]')
        : []),
    ].map((linha) => ({
      nome: linha.querySelector('.margem-nome')?.textContent?.trim() ?? null,
      margem:
        linha.querySelector('[data-prova="margem-municipio-margem"]')?.textContent?.trim() ??
        null,
      lider: linha.querySelector('.margem-lider')?.textContent?.trim() ?? null,
      virou: linha.getAttribute('data-virou') === '1',
    }))
    const contagemCard =
      cardVisivel?.querySelector('[data-prova="margem-viraram"]')?.textContent?.trim() ?? null
    const botaoMargem = document.querySelector('[data-prova="modo-margem"]')
    const botaoReplay = document.querySelector('[data-prova="modo-replay"]')
    const caixa = cardVisivel ? cardVisivel.getBoundingClientRect() : null
    const sheet = document.querySelector('.sheet-margens.is-open')
    const caixaSheet = sheet ? sheet.getBoundingClientRect() : null
    const camada = window.__mapa?.getLayer?.('municipios-margem')
    let featuresVisiveis = 0
    try {
      featuresVisiveis =
        window.__mapa && camada && camada.visibility !== 'none'
          ? window.__mapa.queryRenderedFeatures({ layers: ['municipios-margem'] }).length
          : 0
    } catch {
      featuresVisiveis = 0
    }
    return {
      margem: {
        ativo: margemDebug.ativo ?? null,
        uf: margemDebug.uf ?? null,
        municipios: margemDebug.municipios ?? null,
        municipiosViraram: margemDebug.municipiosViraram ?? null,
        totalViraramAPI: margemDebug.totalViraramAPI ?? null,
        featuresCalor: margemDebug.featuresCalor ?? null,
        camadaVisivel: margemDebug.camadaVisivel ?? null,
        top5: margemDebug.top5 ?? [],
      },
      featuresVisiveis,
      camadaExiste: Boolean(camada),
      camadaVisibility: camada ? camada.visibility ?? 'visible' : null,
      contagemCard,
      linhas,
      cardsNaTela: cards.filter((el) => el.getBoundingClientRect().width > 0).length,
      legenda: Boolean(document.querySelector('[data-prova="legenda-margem"]')),
      notaUf: Boolean(document.querySelector('[data-prova="margem-nota-uf"]')),
      botoes: {
        margem: botaoMargem ? botaoMargem.getAttribute('aria-pressed') : null,
        replay: botaoReplay ? botaoReplay.getAttribute('aria-pressed') : null,
      },
      mapaDebug: {
        featuresZonas: mapaDebug.featuresZonas ?? null,
        featuresMunicipios: mapaDebug.featuresMunicipios ?? null,
        nivel: mapaDebug.nivel ?? null,
        zoom: mapaDebug.zoom ?? null,
      },
      card: caixa
        ? {
            topo: Math.round(caixa.top),
            altura: Math.round(caixa.height),
            largura: Math.round(caixa.width),
            esquerda: Math.round(caixa.left),
          }
        : null,
      sheet: caixaSheet
        ? {
            topo: Math.round(caixaSheet.top),
            altura: Math.round(caixaSheet.height),
            largura: Math.round(caixaSheet.width),
            fracaoTela: Number((caixaSheet.height / window.innerHeight).toFixed(3)),
          }
        : null,
      tela: {
        largura: window.innerWidth,
        altura: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
    }
  })
}

async function esperarCalor(pagina) {
  await pagina.waitForFunction(
    () =>
      window.__margemDebug?.ativo === true &&
      (window.__margemDebug?.municipios || 0) > 0 &&
      (window.__margemDebug?.featuresCalor || 0) > 0,
    { timeout: 90000 },
  )
  // Um quadro a mais: a contagem de features rendidas é refeita no `idle`.
  await dormir(900)
}

async function principal() {
  const opcoes = argumentos(process.argv.slice(2))
  await mkdir(opcoes.out, { recursive: true })

  const ufs = opcoes.uf ? UFS.filter((uf) => uf === opcoes.uf.toUpperCase()) : UFS
  const viewports = opcoes.vp
    ? VIEWPORTS.filter((vp) => vp.nome.startsWith(opcoes.vp))
    : VIEWPORTS

  const resumo = {
    gerado: null,
    base: opcoes.base,
    criterio: 'margem_votos × vv',
    api: {},
    viewports: {},
    exclusividade: null,
    problemas: [],
    ok: false,
  }
  const problemas = resumo.problemas
  const registrar = (obj) => console.log(JSON.stringify(obj))

  // O lado do BACKEND, lido direto da API: é contra isto que a tela é comparada.
  for (const uf of ufs) {
    const resposta = await fetch(`${opcoes.base}/api/uf/${uf}/margens`)
    if (!resposta.ok) throw new Error(`/api/uf/${uf}/margens respondeu ${resposta.status}`)
    const corpo = await resposta.json()
    resumo.api[uf] = {
      total_municipios: corpo.total_municipios,
      total_viraram: corpo.total_viraram,
      comparacao_2022: corpo.comparacao_2022,
      top10: (corpo.municipios || []).slice(0, 10).map((municipio) => ({
        nome: municipio.nome,
        margem_votos: municipio.margem_votos,
        margem_pct: municipio.margem_pct,
        virou_2022: municipio.virou_2022,
      })),
    }
    registrar({ tipo: 'api', uf, ...resumo.api[uf], top10: undefined })
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })

  for (const vp of viewports) {
    for (const uf of ufs) {
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

      const chave = `${uf}_${vp.nome}`
      const dados = { uf, viewport: vp.nome, ligado: null, desligado: null, console: null }

      // ?margem=1 liga o modo no load; ?uf=CE abre a UF (é o que enche a malha
      // municipal, sem a qual não existe calor por município).
      await pagina.goto(`${opcoes.base}/mapa?uf=${uf}&z=7&margem=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      })
      await esperarCalor(pagina)

      const ligado = await medir(pagina)
      const arquivo = path.join(opcoes.out, `margem_${chave}.png`)
      await pagina.screenshot({ path: arquivo })

      const api = resumo.api[uf]
      dados.ligado = {
        featuresCalor: ligado.margem.featuresCalor,
        featuresVisiveis: ligado.featuresVisiveis,
        camadaVisivel: ligado.margem.camadaVisivel,
        municipios: ligado.margem.municipios,
        municipiosViraram: ligado.margem.municipiosViraram,
        totalViraramAPI: ligado.margem.totalViraramAPI,
        apiTotalViraram: api.total_viraram,
        contagemCard: ligado.contagemCard,
        top5: ligado.linhas.slice(0, 5),
        top10_nomes: ligado.linhas.map((linha) => linha.nome),
        legenda: ligado.legenda,
        notaUf: ligado.notaUf,
        botoes: ligado.botoes,
        featuresZonas: ligado.mapaDebug.featuresZonas,
        featuresMunicipios: ligado.mapaDebug.featuresMunicipios,
        zoom: ligado.mapaDebug.zoom,
        card: ligado.card,
        sheet: ligado.sheet,
        tela: ligado.tela,
        arquivo: path.relative(process.cwd(), arquivo),
      }
      registrar({ tipo: 'ligado', chave, ...dados.ligado, top5: undefined })

      // ---- conferências do lado LIGADO
      if (!(ligado.margem.featuresCalor > 0)) {
        problemas.push(`${chave}: nenhuma feature na camada de calor`)
      }
      if (!ligado.margem.camadaVisivel) {
        problemas.push(`${chave}: camada municipios-margem não está visível`)
      }
      if (ligado.margem.municipios !== api.total_municipios) {
        problemas.push(
          `${chave}: card recebeu ${ligado.margem.municipios} municípios, API tem ${api.total_municipios}`,
        )
      }
      if (ligado.margem.municipiosViraram !== api.total_viraram) {
        problemas.push(
          `${chave}: mapa conta ${ligado.margem.municipiosViraram} viraram, API conta ${api.total_viraram}`,
        )
      }
      const contagem = numeroDoTexto(ligado.contagemCard)
      if (contagem !== api.total_viraram) {
        problemas.push(
          `${chave}: card escreve "${ligado.contagemCard}", API diz ${api.total_viraram}`,
        )
      }
      if (ligado.linhas.length === 0) {
        problemas.push(`${chave}: card sem municípios decisivos`)
      }
      if (ligado.linhas.length > 10) {
        problemas.push(`${chave}: card lista ${ligado.linhas.length}, quer no máximo 10`)
      }
      // Top-10 do card == top-10 da API, na mesma ordem.
      const nomesApi = api.top10.map((item) => item.nome)
      const nomesCard = ligado.linhas.map((linha) => linha.nome)
      if (nomesApi.join('|') !== nomesCard.join('|')) {
        problemas.push(
          `${chave}: ordem do card difere da API\n  card: ${nomesCard.join(' | ')}\n  api:  ${nomesApi.join(' | ')}`,
        )
      }
      // A margem em votos mostrada é a da API (tolerância de arredondamento).
      for (let i = 0; i < Math.min(ligado.linhas.length, api.top10.length); i += 1) {
        const mostrada = numeroDoTexto(ligado.linhas[i].margem, 'votos')
        const esperada = api.top10[i].margem_votos
        if (mostrada == null || Math.abs(mostrada - esperada) > 1) {
          problemas.push(
            `${chave}: margem de ${api.top10[i].nome} no card = ${mostrada}, API = ${esperada}`,
          )
        }
      }
      if (!ligado.legenda) problemas.push(`${chave}: legenda do calor ausente`)
      if (ligado.cardsNaTela !== 1) {
        problemas.push(`${chave}: ${ligado.cardsNaTela} card(s) de margem na tela, quer 1`)
      }
      if (!(ligado.mapaDebug.featuresZonas > 0)) {
        problemas.push(`${chave}: featuresZonas zerado com a UF aberta (${ligado.mapaDebug.featuresZonas})`)
      }
      if (!(ligado.mapaDebug.featuresMunicipios > 0)) {
        problemas.push(`${chave}: featuresMunicipios zerado (${ligado.mapaDebug.featuresMunicipios})`)
      }

      // Mobile: o card não pode comer o mapa nem criar scroll horizontal.
      if (vp.nome.startsWith('mobile')) {
        if (ligado.tela.scrollWidth > ligado.tela.clientWidth) {
          problemas.push(
            `${chave}: scroll horizontal (${ligado.tela.scrollWidth} > ${ligado.tela.clientWidth})`,
          )
        }
        if (ligado.card && ligado.card.largura > ligado.tela.largura) {
          problemas.push(
            `${chave}: card mais largo que a tela (${ligado.card.largura} > ${ligado.tela.largura})`,
          )
        }
      }

      // ---- DESLIGAR: clicar de novo o MARGEM tem de restaurar o mapa
      await pagina.click('[data-prova="modo-margem"]')
      await pagina.waitForFunction(
        () => window.__margemDebug?.ativo === false,
        { timeout: 30000 },
      )
      await dormir(700)
      const desligado = await medir(pagina)
      dados.desligado = {
        ativo: desligado.margem.ativo,
        featuresCalor: desligado.margem.featuresCalor,
        featuresVisiveis: desligado.featuresVisiveis,
        camadaVisivel: desligado.margem.camadaVisivel,
        camadaExiste: desligado.camadaExiste,
        camadaVisibility: desligado.camadaVisibility,
        linhas: desligado.linhas.length,
        botoes: desligado.botoes,
        featuresZonas: desligado.mapaDebug.featuresZonas,
        featuresMunicipios: desligado.mapaDebug.featuresMunicipios,
      }
      registrar({ tipo: 'desligado', chave, ...dados.desligado })

      if (desligado.margem.ativo !== false) {
        problemas.push(`${chave}: MARGEM não desligou ao clicar de novo`)
      }
      if ((desligado.margem.featuresCalor || 0) !== 0 || desligado.featuresVisiveis !== 0) {
        problemas.push(
          `${chave}: calor continuou desenhado depois de desligar (contagem=${desligado.margem.featuresCalor}, visiveis=${desligado.featuresVisiveis})`,
        )
      }
      if (desligado.camadaVisibility !== 'none') {
        problemas.push(`${chave}: visibility da camada = ${desligado.camadaVisibility}, quer none`)
      }
      if (desligado.botoes.margem !== 'false') {
        problemas.push(`${chave}: aria-pressed do MARGEM = ${desligado.botoes.margem}, quer false`)
      }
      if (!(desligado.mapaDebug.featuresZonas > 0)) {
        problemas.push(`${chave}: featuresZonas zerou ao desligar MARGEM`)
      }

      // ---- EXCLUSIVIDADE (só no desktop de CE: custa baixar a série do replay)
      if (vp.nome.startsWith('desktop') && uf === 'CE') {
        await pagina.click('[data-prova="modo-margem"]')
        await pagina.waitForFunction(
          () => window.__margemDebug?.ativo === true,
          { timeout: 30000 },
        )
        await pagina.click('[data-prova="modo-replay"]')
        await dormir(1500)
        const comReplay = await medir(pagina)
        const margemSaiu = comReplay.margem.ativo === false
        const replayEntrou = comReplay.botoes.replay === 'true'
        await pagina.click('[data-prova="modo-margem"]')
        await dormir(1500)
        const comMargem = await medir(pagina)
        const replaySaiu = comMargem.botoes.replay === 'false'
        const margemEntrou = comMargem.margem.ativo === true

        resumo.exclusividade = {
          margem_desliga_ao_ligar_replay: margemSaiu,
          replay_liga: replayEntrou,
          replay_desliga_ao_ligar_margem: replaySaiu,
          margem_liga: margemEntrou,
          botoes_apos_replay: comReplay.botoes,
          botoes_apos_margem: comMargem.botoes,
          calor_apos_replay: comReplay.margem.featuresCalor,
          calor_apos_margem: comMargem.margem.featuresCalor,
        }
        registrar({ tipo: 'exclusividade', ...resumo.exclusividade })
        if (!margemSaiu || !replayEntrou) {
          problemas.push('exclusividade: ligar REPLAY não desligou MARGEM')
        }
        if (!replaySaiu || !margemEntrou) {
          problemas.push('exclusividade: ligar MARGEM não desligou REPLAY')
        }
      }

      const errosLimpos = [...new Set(erros)]
      const ruinsLimpos = [...new Set(respostasRuins)]
      dados.console = { erros: errosLimpos, respostas_ruins: ruinsLimpos }
      registrar({ tipo: 'console', chave, ...dados.console })
      if (errosLimpos.length > 0) {
        problemas.push(`${chave}: console com ${errosLimpos.length} erro(s): ${errosLimpos.join(' | ')}`)
      }
      if (ruinsLimpos.length > 0) {
        problemas.push(`${chave}: respostas >=400: ${ruinsLimpos.join(' | ')}`)
      }

      resumo.viewports[chave] = dados
      await contexto.close()
    }
  }

  await browser.close()

  resumo.ok = problemas.length === 0
  resumo.gerado = new Date().toISOString()
  const saida = path.join(opcoes.out, 'margem_resumo.json')
  await writeFile(saida, `${JSON.stringify(resumo, null, 2)}\n`)

  registrar({ tipo: 'resumo', ok: resumo.ok, problemas, arquivo: saida })
  if (!resumo.ok) process.exitCode = 1
}

principal().catch((erro) => {
  console.error(`falha na prova: ${erro.message}`)
  process.exitCode = 1
})
