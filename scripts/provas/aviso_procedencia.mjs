#!/usr/bin/env node
// aviso_procedencia.mjs — prova que a tela DIZ de que turno é o dado quando o
// painel está num turno e os arquivos são de outro.
//
// Não clica em nada e não mexe em camada: abre /mapa, espera a apuração
// carregar e lê o texto do rodapé ([data-prova="municipal-aviso"] e o aviso de
// snapshot em [data-prova="dados-aviso"]). Só mede o que está escrito na tela.
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/aviso_procedencia.mjs --base http://127.0.0.1:8100 \
//     --out _provas --prefix aviso_procedencia
//
// Saída: aviso_procedencia_resumo.json com os textos encontrados e o veredito.
// Critério (quem lê o resumo): turno configurado 2 + arquivos do 1º turno ⇒
// os dois avisos aparecem e citam "1º turno"; turno 1 ⇒ os dois vazios.
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8100', out: '_provas', prefix: 'aviso_procedencia' }
  for (let indice = 0; indice < argv.length; indice += 1) {
    const [chave, valorNaMesmaLinha] = String(argv[indice]).split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = valorNaMesmaLinha ?? argv[indice + 1]
    if (valorNaMesmaLinha === undefined) indice += 1
  }
  return opcoes
}

const texto = async (page, seletor) => {
  const alvo = page.locator(seletor)
  if (!(await alvo.count())) return null
  return (await alvo.first().innerText()).replace(/\s+/g, ' ').trim()
}

async function principal() {
  const { base, out, prefix } = lerArgumentos(process.argv.slice(2))
  await mkdir(out, { recursive: true })
  const navegador = await chromium.launch()
  const pagina = await navegador.newPage({ viewport: { width: 1440, height: 900 } })
  const resultado = { base, gerado: new Date().toISOString(), problemas: [] }

  try {
    await pagina.goto(`${base}/mapa`, { waitUntil: 'load', timeout: 45000 })
    await pagina.waitForSelector('[data-prova="header-meta"]', { timeout: 30000 })
    // espera a apuração sair de "carregando"
    await pagina
      .waitForFunction(
        () => !/carregando/.test(document.querySelector('[data-prova="header-meta"]')?.textContent || ''),
        null,
        { timeout: 30000 },
      )
      .catch(() => {})
    await pagina.waitForTimeout(1500)

    const estados = await pagina.evaluate(async () => {
      const resposta = await fetch('/api/estados', { cache: 'no-store' })
      return resposta.ok ? resposta.json() : null
    })
    resultado.turno = estados?.turno ?? null
    resultado.eleicao = estados?.eleicao ?? null
    resultado.dados_eleicao = estados?.dados_eleicao ?? null
    resultado.municipal_aviso_api = estados?.municipal?.aviso ?? ''
    resultado.dados_aviso_api = estados?.dados_aviso ?? ''

    resultado.municipal_aviso_tela = await texto(pagina, '[data-prova="municipal-aviso"]')
    resultado.dados_aviso_tela = await texto(pagina, '[data-prova="dados-aviso"]')
    resultado.header = await texto(pagina, '[data-prova="header-meta"]')

    // Critério: o que está na API tem de estar na TELA.
    if (resultado.municipal_aviso_api && !resultado.municipal_aviso_tela) {
      resultado.problemas.push('aviso municipal existe na API e não aparece na tela')
    }
    if (resultado.dados_aviso_api && !resultado.dados_aviso_tela) {
      resultado.problemas.push('aviso do snapshot existe na API e não aparece na tela')
    }
    if (resultado.municipal_aviso_tela && !/1º turno|2º turno/.test(resultado.municipal_aviso_tela)) {
      resultado.problemas.push('aviso municipal na tela não diz de que turno é o dado')
    }
    if (!resultado.municipal_aviso_api && resultado.municipal_aviso_tela) {
      resultado.problemas.push('tela mostra aviso municipal que a API não declarou')
    }
    await pagina.screenshot({ path: path.join(out, `${prefix}_desktop_1440x900.png`), fullPage: false })
  } catch (erro) {
    resultado.problemas.push(`erro na prova: ${erro.message}`)
  } finally {
    await navegador.close()
  }

  resultado.ok = resultado.problemas.length === 0
  const arquivo = path.join(out, `${prefix}_resumo.json`)
  await writeFile(arquivo, JSON.stringify(resultado, null, 1), 'utf8')
  console.log(JSON.stringify(resultado, null, 1))
  console.log(`resumo: ${arquivo}`)
  process.exit(resultado.ok ? 0 : 1)
}

principal()
