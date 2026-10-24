#!/usr/bin/env node
// Prova visual das fotos (item B1/B2): placar com as duas fotos, card de estado
// com figurinhas/destaques e o fallback de inicial quando a foto não carrega.
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/identidade.mjs --base http://127.0.0.1:8100 --out _provas
//
//   ... --fallback    roda o modo de prova do aviso: exige que NENHUMA foto do
//                     candidato 13 carregue e que o avatar com inicial esteja no
//                     lugar (sem <img> quebrada, sem 404 no console).
//
// Além dos prints, imprime um relatório legível por máquina (uma linha JSON por
// impressão + um resumo final) para servir de prova no ROADMAP.
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop_1440x900', largura: 1440, altura: 900, zoom: '6.3' },
  { nome: 'mobile_390x844', largura: 390, altura: 844, zoom: '5.9' },
]

const ESTADOS = ['CE', 'RS']

// Modo --fotos: prova a FOTO por UF (item 11) em três estados de tema bem
// diferentes (praia, serra, centro histórico).
const ESTADOS_FOTOS = ['CE', 'RS', 'BA']

function argumentos(argv) {
  const opcoes = {
    base: 'http://127.0.0.1:8100',
    out: '_provas',
    fallback: false,
    fotos: false,
    placeholder: false,
    vp: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const [chave, mesmo] = argv[i].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (nome === 'fallback' || nome === 'fotos' || nome === 'placeholder') {
      opcoes[nome] = true
      continue
    }
    if (!(nome in opcoes)) continue
    opcoes[nome] = mesmo ?? argv[i + 1]
    if (mesmo == null) i += 1
  }
  opcoes.base = opcoes.base.replace(/\/+$/, '')
  return opcoes
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

// Espera o mapa assentar (mesma ideia do captura.mjs) e todas as fotos
// terminarem de carregar — print antes disso mostraria círculo vazio.
async function esperarPronto(pagina) {
  await pagina
    .waitForFunction(() => {
      const mapa = window.__mapa
      return mapa && mapa.loaded() && document.querySelector('.scoreboard')
    }, { timeout: 45000 })
    .catch(() => {})
  await pagina
    .waitForFunction(
      () =>
        [...document.querySelectorAll('img.avatar')]
          .filter((img) => img.getBoundingClientRect().width > 0)
          .every((img) => img.complete),
      { timeout: 15000 },
    )
    .catch(() => {})
  await dormir(900)
}

async function medirAvatares(pagina) {
  return pagina.evaluate(() => {
    // Só o que está RENDERIZADO: o app monta o placar do desktop e a gaveta do
    // celular no mesmo DOM, e o que não está no viewport tem 0x0 (com
    // loading=lazy a imagem nem chega a baixar). Medir o escondido era o que
    // acusava "foto não carregou" com a foto na tela.
    const visivel = (el) => el.getBoundingClientRect().width > 0
    const fotos = [...document.querySelectorAll('img.avatar')]
      .filter(visivel)
      .map((img) => {
        const caixa = img.getBoundingClientRect()
        return {
          classe: img.className,
          arquivo: img.getAttribute('src'),
          numero: img.dataset.fotoOficial || null,
          base64: img.currentSrc.startsWith('data:'),
          carregou: img.complete && img.naturalWidth > 0,
          natural: `${img.naturalWidth}x${img.naturalHeight}`,
          renderizado: `${Math.round(caixa.width)}x${Math.round(caixa.height)}`,
        }
      })
    const iniciais = [...document.querySelectorAll('.avatar--inicial')]
      .filter(visivel)
      .map((el) => {
        const caixa = el.getBoundingClientRect()
        return {
          classe: el.className,
          texto: el.textContent,
          titulo: el.title,
          renderizado: `${Math.round(caixa.width)}x${Math.round(caixa.height)}`,
        }
      })
    const identidade = [...document.querySelectorAll('.identidade')]
      .filter(visivel)
      .map((secao) => ({
      apelido: secao.querySelector('.identidade-apelido')?.textContent || null,
      figurinhas: [...secao.querySelectorAll('.identidade-figurinhas span')].map(
        (s) => s.textContent,
      ),
      destaques: [...secao.querySelectorAll('.identidade-destaques li')].map((li) =>
        li.textContent.trim(),
      ),
      caixa: (() => {
        const c = secao.getBoundingClientRect()
        return `${Math.round(c.width)}x${Math.round(c.height)}`
      })(),
    }))
    return { fotos, iniciais, identidade }
  })
}

async function recortar(pagina, seletor, arquivo) {
  // No celular o mesmo componente é montado duas vezes: no aside do desktop
  // (display:none) e no sheet de detalhe. `.first()` pegava o invisível e a
  // prova do card saía vazia — então procura o primeiro que está na tela.
  const alvos = pagina.locator(seletor)
  const total = await alvos.count()
  for (let i = 0; i < total; i += 1) {
    const alvo = alvos.nth(i)
    try {
      if (!(await alvo.isVisible())) continue
      await alvo.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {})
      await alvo.screenshot({ path: arquivo, timeout: 8000, animations: 'disabled' })
      return arquivo
    } catch (erro) {
      console.log(`  aviso: recorte ${seletor} falhou: ${erro.message.split('\n')[0]}`)
    }
  }
  return null
}

async function medirFotosUF(pagina) {
  return pagina.evaluate(() => {
    const visivel = (el) => el.getBoundingClientRect().width > 0
    // Só o card de estado que está na tela: no celular o mesmo componente é
    // montado no aside do desktop (display:none) e no sheet.
    const cartoes = [...document.querySelectorAll('.detail-card')].filter(visivel)
    const medidas = cartoes.map((cartao) => {
      const secao = cartao.querySelector('.identidade')
      if (!secao) return null
      const img = secao.querySelector('.identidade-foto img')
      const vazia = secao.querySelector('.identidade-foto--vazia')
      const credito = cartao.querySelector('.detail-credito')
      const caixa = img ? img.getBoundingClientRect() : null
      const estilo = img ? getComputedStyle(img) : null
      const caixaCredito = credito ? credito.getBoundingClientRect() : null
      return {
        uf: cartao.querySelector('.detail-uf')?.textContent?.trim() || null,
        tem_img: Boolean(img),
        src: img?.getAttribute('src') || null,
        alt: img?.getAttribute('alt') || null,
        carregou: img ? img.complete && img.naturalWidth > 0 : false,
        natural: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
        renderizado: caixa ? `${Math.round(caixa.width)}x${Math.round(caixa.height)}` : null,
        object_fit: estilo ? estilo.objectFit : null,
        placeholder: vazia ? vazia.getAttribute('aria-label') : null,
        credito: credito ? credito.textContent.trim() : null,
        credito_visivel: Boolean(caixaCredito && caixaCredito.height > 0 && caixaCredito.width > 0),
      }
    })
    return {
      medidas: medidas.filter(Boolean),
      scroll: {
        documento: document.documentElement.scrollWidth,
        janela: window.innerWidth,
        horizontal: document.documentElement.scrollWidth > window.innerWidth + 1,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Modo --fotos (item 11): a FOTO da UF no cartão do estado.
//
// Mede, para CE/RS/BA e nos dois viewports, que a imagem carrega de verdade
// (naturalWidth > 0), que tem alt descritivo, que a linha "Foto: autor ·
// licença" está visível no rodapé do cartão, que o object-fit é cover e que
// nada respondeu >= 400. `--placeholder` intercepta /api/estados/identidade e
// devolve CE com foto: null para provar o cartão de fallback sem mexer no dado.
// ---------------------------------------------------------------------------
async function provarFotos(opcoes) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })

  const ufs = opcoes.placeholder ? ['CE'] : ESTADOS_FOTOS
  const resumo = []
  const problemas = []

  for (const vp of VIEWPORTS) {
    const contexto = await browser.newContext({
      viewport: { width: vp.largura, height: vp.altura },
      deviceScaleFactor: 1,
    })
    const pagina = await contexto.newPage()

    const erros = []
    const comErro = []
    pagina.on('console', (msg) => {
      if (msg.type() === 'error') erros.push(msg.text())
    })
    pagina.on('pageerror', (erro) => erros.push(`pageerror: ${erro.message}`))
    pagina.on('response', (resp) => {
      if (resp.status() >= 400) comErro.push(`${resp.status()} ${resp.url()}`)
    })

    if (opcoes.placeholder) {
      await pagina.route('**/api/estados/identidade', async (rota) => {
        const resposta = await rota.fetch()
        const corpo = await resposta.json()
        if (corpo?.UF?.CE) {
          corpo.UF.CE.foto = null
          corpo.UF.CE.alt = null
        }
        await rota.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(corpo),
        })
      })
    }

    for (const uf of ufs) {
      const url = `${opcoes.base}/mapa?uf=${uf}&z=${vp.zoom}`
      await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await esperarPronto(pagina)

      if (vp.largura < 820) {
        const alca = pagina.locator('.sheet-detalhe .sheet-header-toque')
        if (await alca.count()) {
          await alca.click()
          await dormir(900)
        }
      }

      // A foto é lazy: espera ela terminar antes de medir e fotografar.
      await pagina
        .waitForFunction(
          () => {
            const imgs = [...document.querySelectorAll('.identidade-foto img')].filter(
              (img) => img.getBoundingClientRect().width > 0,
            )
            return imgs.length > 0 ? imgs.every((img) => img.complete) : true
          },
          { timeout: 20000 },
        )
        .catch(() => {})
      await dormir(400)

      const medicao = await medirFotosUF(pagina)
      const marca = opcoes.placeholder
        ? `identidade_foto_${uf}_placeholder_${vp.nome}`
        : `identidade_foto_${uf}_${vp.nome}`
      const arquivo = path.join(opcoes.out, `${marca}.png`)
      await pagina.screenshot({ path: arquivo })
      await recortar(pagina, '.detail-card', path.join(opcoes.out, `${marca}_card.png`))

      const doEstado = medicao.medidas.find((m) => m.uf === uf) || medicao.medidas[0] || null
      const linha = {
        uf,
        viewport: vp.nome,
        url,
        print: arquivo,
        foto: doEstado,
        scroll: medicao.scroll,
        console_errors: erros.slice(),
        requests_erro: comErro.slice(),
      }
      resumo.push(linha)
      console.log(JSON.stringify(linha))

      const rotulo = `${uf}/${vp.nome}`
      if (!doEstado) {
        problemas.push(`${rotulo}: sem cartão de estado medido`)
      } else if (opcoes.placeholder) {
        if (doEstado.tem_img) problemas.push(`${rotulo}: esperava placeholder, achei <img>`)
        if (!doEstado.placeholder) problemas.push(`${rotulo}: sem placeholder com aria-label`)
        if (doEstado.credito_visivel) {
          problemas.push(`${rotulo}: crédito apareceu sem foto -> ${doEstado.credito}`)
        }
      } else {
        if (!doEstado.tem_img) problemas.push(`${rotulo}: sem imagem no cartão`)
        if (!doEstado.carregou) {
          problemas.push(`${rotulo}: imagem não carregou (natural ${doEstado.natural})`)
        }
        if (!doEstado.alt || doEstado.alt.length < 8) {
          problemas.push(`${rotulo}: alt ausente/curto -> ${JSON.stringify(doEstado.alt)}`)
        }
        if (!doEstado.credito_visivel) problemas.push(`${rotulo}: crédito não visível`)
        if (!/^Foto: .+ · .+/.test(doEstado.credito || '')) {
          problemas.push(`${rotulo}: crédito fora do formato -> ${JSON.stringify(doEstado.credito)}`)
        }
        if (doEstado.object_fit !== 'cover') {
          problemas.push(`${rotulo}: object-fit ${doEstado.object_fit}, esperava cover`)
        }
      }
      if (medicao.scroll.horizontal) {
        problemas.push(
          `${rotulo}: scroll horizontal (${medicao.scroll.documento} > ${medicao.scroll.janela})`,
        )
      }
      if (erros.length) problemas.push(`${rotulo}: console -> ${JSON.stringify(erros.slice(0, 3))}`)
      if (comErro.length) problemas.push(`${rotulo}: request >= 400 -> ${JSON.stringify(comErro)}`)
    }

    await contexto.close()
  }

  await browser.close()

  const saida = path.join(
    opcoes.out,
    opcoes.placeholder ? 'identidade_fotos_placeholder_resumo.json' : 'identidade_fotos_resumo.json',
  )
  const conteudo = {
    gerado_em: new Date().toISOString(),
    base: opcoes.base,
    modo: opcoes.placeholder ? 'placeholder' : 'fotos',
    ufs,
    viewports: VIEWPORTS.map((v) => v.nome),
    impressoes: resumo,
    problemas,
    ok: problemas.length === 0,
  }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(saida, `${JSON.stringify(conteudo, null, 2)}\n`, 'utf8')
  console.log(`\nresumo: ${resumo.length} impressões, ${problemas.length} problema(s) -> ${saida}`)
  for (const p of problemas) console.log(`  PROBLEMA: ${p}`)
  if (problemas.length) process.exitCode = 1
}

async function principal() {
  const opcoes = argumentos(process.argv.slice(2))
  await mkdir(path.join(opcoes.out), { recursive: true })

  if (opcoes.fotos || opcoes.placeholder) {
    await provarFotos(opcoes)
    return
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

  const resumo = []
  const problemas = []

  const viewports = opcoes.vp
    ? VIEWPORTS.filter((v) => v.nome.startsWith(opcoes.vp))
    : VIEWPORTS

  for (const vp of viewports) {
    const contexto = await browser.newContext({
      viewport: { width: vp.largura, height: vp.altura },
      deviceScaleFactor: 1,
    })
    const pagina = await contexto.newPage()

    const erros = []
    const comErro = []
    pagina.on('console', (msg) => {
      if (msg.type() === 'error') erros.push(msg.text())
    })
    pagina.on('pageerror', (erro) => erros.push(`pageerror: ${erro.message}`))
    pagina.on('response', (resp) => {
      if (resp.status() >= 400) comErro.push(`${resp.status()} ${resp.url()}`)
    })

    for (const uf of ESTADOS) {
      const url = `${opcoes.base}/mapa?uf=${uf}&z=${vp.zoom}`
      await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await esperarPronto(pagina)

      const marca = opcoes.fallback ? 'fallback' : 'identidade'
      const base = path.join(opcoes.out, `${marca}_${uf}_${vp.nome}`)

      // No celular o sheet de detalhe nasce em peek e o peek esconde o corpo
      // (`.sheet-detalhe.is-peek .sheet-body { display: none }`). Sem expandir,
      // o card do estado — e a seção .identidade junto — nem existe na tela.
      if (vp.largura < 820) {
        const alca = pagina.locator('.sheet-detalhe .sheet-header-toque')
        if (await alca.count()) {
          await alca.click()
          await dormir(900)
        }
      }

      // 1) Card do estado (com as figurinhas/destaques e o avatar do líder).
      const noCard = await medirAvatares(pagina)
      await pagina.screenshot({ path: `${base}.png` })
      await recortar(pagina, '.identidade', `${base}_card.png`)

      // 2) Placar. No desktop está sempre à vista; no celular mora na gaveta
      // do topo, fechada por padrão — sem abrir, o print sai sem as fotos.
      const arquivoPlacar = `${base}_placar.png`
      if (vp.largura < 820) {
        if (await pagina.isVisible('.sheet-detalhe .sheet-close')) {
          await pagina.click('.sheet-detalhe .sheet-close')
          await dormir(800)
        }
        const gavetaAberta = await pagina
          .evaluate(() => {
            const g = document.querySelector('.placar-gaveta')
            return Boolean(g && g.className.includes('is-open'))
          })
          .catch(() => false)
        if (!gavetaAberta && (await pagina.locator('.placar-gaveta .sheet-resumo').count())) {
          await pagina.click('.placar-gaveta .sheet-resumo')
          await dormir(900)
        }
        await pagina.screenshot({ path: `${base}_gaveta.png` })
        await recortar(pagina, '.placar-gaveta', arquivoPlacar)
      } else {
        await recortar(pagina, '.scoreboard', arquivoPlacar)
      }

      const noPlacar = await medirAvatares(pagina)
      const medicao = {
        fotos: [...noCard.fotos, ...noPlacar.fotos],
        iniciais: [...noCard.iniciais, ...noPlacar.iniciais],
        identidade: noCard.identidade,
      }

      const linha = {
        uf,
        viewport: vp.nome,
        url,
        prints: [`${base}.png`, arquivoPlacar, `${base}_card.png`],
        fotos: medicao.fotos,
        iniciais: medicao.iniciais,
        identidade: medicao.identidade,
        console_errors: erros.slice(),
        requests_erro: comErro.slice(),
      }
      resumo.push(linha)
      console.log(JSON.stringify(linha))

      // Conferências por modo.
      const fotosQuebradas = medicao.fotos.filter((f) => !f.carregou && !opcoes.fallback)
      if (fotosQuebradas.length) {
        problemas.push(`${uf}/${vp.nome}: foto não carregou -> ${JSON.stringify(fotosQuebradas)}`)
      }
      if (!opcoes.fallback) {
        // Os dois rostos, um de cada candidato — não a mesma foto duas vezes.
        const numeros = new Set(medicao.fotos.map((f) => f.numero))
        if (!numeros.has('13') || !numeros.has('22')) {
          problemas.push(
            `${uf}/${vp.nome}: esperava as fotos 13 e 22 no placar, achei ${JSON.stringify([...numeros])}`,
          )
        }
        if (medicao.identidade.length === 0) {
          problemas.push(`${uf}/${vp.nome}: sem seção .identidade no card de ${uf}`)
        } else {
          const secao = medicao.identidade[0]
          if (secao.figurinhas.length !== 3 || secao.destaques.length === 0) {
            problemas.push(
              `${uf}/${vp.nome}: identidade incompleta -> ${JSON.stringify(secao)}`,
            )
          }
        }
      }
      if (opcoes.fallback) {
        const foto13 = medicao.fotos.filter((f) => f.numero === '13')
        if (foto13.length) {
          problemas.push(`${uf}/${vp.nome}: foto 13 continuou carregando (esperava inicial)`)
        }
        const inicial = medicao.iniciais.find((i) => i.texto === 'L')
        if (!inicial) {
          problemas.push(
            `${uf}/${vp.nome}: sem avatar de inicial "L" (achei ${JSON.stringify(medicao.iniciais)})`,
          )
        }
        const quebradas = medicao.fotos.filter((f) => !f.carregou)
        if (quebradas.length) {
          problemas.push(`${uf}/${vp.nome}: <img> quebrada -> ${JSON.stringify(quebradas)}`)
        }
      }
    }

    await contexto.close()
  }

  await browser.close()

  console.log(`\nresumo: ${resumo.length} impressões, ${problemas.length} problema(s)`)
  for (const p of problemas) console.log(`  PROBLEMA: ${p}`)
  if (problemas.length) process.exitCode = 1
}

principal().catch((erro) => {
  console.error('FALHOU:', erro)
  process.exitCode = 1
})
