import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import {
  CARTO_POSITRON,
  CORES_PARTIDO,
  COR_NEUTRA,
  EXPRESSAO_COR,
  ZOOM_LOCAL,
  ZOOM_MUNICIPIO,
  nivelPorZoom,
} from '../mapa.js'
import { numero, percentual, pontos } from '../format.js'

const FONTE = 'ufs'
const LAYER_FILL = 'ufs-fill'
const LAYER_LINE = 'ufs-line'
const LAYER_HOVER = 'ufs-hover'
const LAYER_SELECTED = 'ufs-selected'

const FONTE_MUNICIPIOS = 'municipios'
const FONTE_ZONAS = 'zonas'
const LAYER_ZONAS = 'zonas-prisma'
const LAYER_MUN_FILL = 'municipios-fill'
const LAYER_MUN_LINE = 'municipios-line'
const LAYER_MUN_LABELS = 'municipios-labels'

const FONTE_LOCAIS = 'locais'
const FONTE_LOCAIS_PONTOS = 'locais-pontos'
const LAYER_LOCAL_PRISMA = 'locais-prisma'
const LAYER_LOCAL_CLUSTER = 'locais-cluster'
const LAYER_LOCAL_CLUSTER_COUNT = 'locais-cluster-count'
const LAYER_LOCAL_PONTO = 'locais-ponto'
const LAYER_LOCAL_HIT = 'locais-hit'
const LAYER_LOCAL_SELECIONADO = 'locais-selecionado'

// Os rótulos de município só entram quando as colunas 3D já desceram a zero
// (ver ALTURA_PRISMAS): antes disso o símbolo cai atrás do prisma e aparece
// cortado. Este é o zoom mínimo seguro.
const ZOOM_ROTULO_MUNICIPIO = 8.4

// Acima disto o município tem locais demais para desenhar prisma por local; a
// camada cai para pontos puros (o raio continua codificando os votos).
const LIMITE_LOCAIS_PRISMA = 400

function canaisDaCor(hex) {
  const valor = Number.parseInt(String(hex).replace('#', ''), 16)
  if (!Number.isFinite(valor)) return [154, 160, 166]
  return [(valor >> 16) & 255, (valor >> 8) & 255, valor & 255]
}

const CANAIS_PL = canaisDaCor(CORES_PARTIDO.PL)
const CANAIS_PT = canaisDaCor(CORES_PARTIDO.PT)
const CANAIS_NEUTRA = canaisDaCor(COR_NEUTRA)

// A opacidade do prisma não aceita expressão por feature. Colocamos a fração
// apurada no canal alfa da cor e deixamos a opacidade da camada fazer o fade
// por zoom; o resultado visual é 0,9 × pct_apurado/100.
const COR_ZONA = [
  'rgba',
  [
    'case',
    ['==', ['get', 'partido_lider'], 'PL'],
    CANAIS_PL[0],
    ['==', ['get', 'partido_lider'], 'PT'],
    CANAIS_PT[0],
    CANAIS_NEUTRA[0],
  ],
  [
    'case',
    ['==', ['get', 'partido_lider'], 'PL'],
    CANAIS_PL[1],
    ['==', ['get', 'partido_lider'], 'PT'],
    CANAIS_PT[1],
    CANAIS_NEUTRA[1],
  ],
  [
    'case',
    ['==', ['get', 'partido_lider'], 'PL'],
    CANAIS_PL[2],
    ['==', ['get', 'partido_lider'], 'PT'],
    CANAIS_PT[2],
    CANAIS_NEUTRA[2],
  ],
  [
    '/',
    ['coalesce', ['get', 'pct_apurado'], 100],
    100,
  ],
]

const OPACIDADE_UFS_COM_DETALHE = [
  'interpolate',
  ['linear'],
  ['zoom'],
  4.6,
  0.85,
  5.8,
  0.06,
]

// As colunas das zonas saem de cena ANTES dos rótulos de município entrarem
// (ZOOM_ROTULO_MUNICIPIO): altura 0 significa nenhum fragmento no depth buffer,
// então nada fica na frente do texto.
const OPACIDADE_PRISMAS = [
  'interpolate',
  ['linear'],
  ['zoom'],
  5.0,
  0,
  6.2,
  0.9,
  7.2,
  0.9,
  7.8,
  0.35,
  8.2,
  0,
]

const ALTURA_PRISMAS = [
  'interpolate',
  ['linear'],
  ['zoom'],
  5.0,
  0,
  6.2,
  ['coalesce', ['get', 'altura_m'], 0],
  7.2,
  ['coalesce', ['get', 'altura_m'], 0],
  8.2,
  0,
]

const OPACIDADE_MUNICIPIOS = [
  'interpolate',
  ['linear'],
  ['zoom'],
  6.6,
  0,
  7.4,
  0.82,
]

const OPACIDADE_MUNICIPIOS_LINHA = [
  'interpolate',
  ['linear'],
  ['zoom'],
  6.6,
  0,
  7.4,
  0.9,
]

// A cor do prisma do local conta a fração apurada: começa clara e chega à cor
// cheia do partido quando a urna está 100% apurada.
const COR_PRISMA_LOCAL = [
  'match',
  ['get', 'partido_lider'],
  'PL',
  [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'pct_apurado'], 100],
    0,
    '#c9d9ee',
    100,
    CORES_PARTIDO.PL,
  ],
  'PT',
  [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'pct_apurado'], 100],
    0,
    '#f3cdd1',
    100,
    CORES_PARTIDO.PT,
  ],
  [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'pct_apurado'], 100],
    0,
    '#e6e8ea',
    100,
    COR_NEUTRA,
  ],
]

const CORES_ICONE = {
  PL: CORES_PARTIDO.PL,
  PT: CORES_PARTIDO.PT,
  NEUTRO: COR_NEUTRA,
}

const BUCKETS_ICONE = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

// Ícone do local: disco branco, anel cinza e arco colorido do topo em sentido
// horário proporcional ao percentual apurado. A 100% vira disco sólido com
// borda branca.
function criarCanvasIconeLocal(bucket, cor) {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const contexto = canvas.getContext('2d')
  if (!contexto) return canvas

  const centro = 32
  const raio = 28

  contexto.beginPath()
  contexto.arc(centro, centro, raio, 0, Math.PI * 2)
  contexto.fillStyle = '#ffffff'
  contexto.fill()

  if (bucket >= 100) {
    contexto.beginPath()
    contexto.arc(centro, centro, raio - 2, 0, Math.PI * 2)
    contexto.fillStyle = cor
    contexto.fill()
    contexto.lineWidth = 4
    contexto.strokeStyle = '#ffffff'
    contexto.stroke()
    return canvas
  }

  const raioAnel = 23
  contexto.beginPath()
  contexto.arc(centro, centro, raioAnel, 0, Math.PI * 2)
  contexto.lineWidth = 9
  contexto.strokeStyle = '#c9ced6'
  contexto.stroke()

  if (bucket > 0) {
    const inicio = -Math.PI / 2
    contexto.beginPath()
    contexto.arc(
      centro,
      centro,
      raioAnel,
      inicio,
      inicio + 2 * Math.PI * (Math.min(bucket, 100) / 100),
      false,
    )
    contexto.lineWidth = 9
    contexto.strokeStyle = cor
    contexto.stroke()
  }

  return canvas
}

// addImage no load, no styledata e no idle, só para os ids que ainda não
// existem no estilo. O styledata pode trocar o estilo inteiro (basemap), então
// re-registrar é barato e evita ícone faltando.
let avisouFalhaIcone = false

export function registrarIconesLocais(mapa) {
  if (!mapa) return
  if (typeof mapa.isStyleLoaded === 'function' && !mapa.isStyleLoaded()) return

  for (const bucket of BUCKETS_ICONE) {
    for (const [partido, cor] of Object.entries(CORES_ICONE)) {
      const id = `local-${bucket}-${partido}`
      if (typeof mapa.hasImage === 'function' && mapa.hasImage(id)) continue
      try {
        // O MapLibre 5.24 NÃO aceita HTMLCanvasElement em addImage: ele valida
        // width*height*4 e o canvas falha com "mismatched image size. expected:
        // 0 but got: 16384" — o ícone nunca era registrado e a camada
        // locais-ponto não desenhava nada. ImageData (mesmas pixels) passa.
        const canvas = criarCanvasIconeLocal(bucket, cor)
        const contexto = canvas.getContext('2d')
        mapa.addImage(
          id,
          contexto.getImageData(0, 0, canvas.width, canvas.height),
          { pixelRatio: 2 },
        )
      } catch (erro) {
        // Troca de estilo em andamento é esperada; qualquer outra falha tem que
        // aparecer uma vez no console em vez de sumir num catch vazio (foi assim
        // que o bug do addImage passou despercebido).
        if (!avisouFalhaIcone) {
          avisouFalhaIcone = true
          console.warn(
            'ícones de local não registrados:',
            erro?.message || erro,
          )
        }
      }
    }
  }
}

// A coluna do local nasce do chão entre ZOOM_LOCAL e ZOOM_LOCAL + 0,5 para a
// troca zona -> local ser suave (nada aparece/some de um frame para o outro).
const ALTURA_LOCAL = [
  'interpolate',
  ['linear'],
  ['zoom'],
  ZOOM_LOCAL,
  0,
  ZOOM_LOCAL + 0.5,
  ['get', 'altura_m'],
]

const OPACIDADE_LOCAL = [
  'interpolate',
  ['linear'],
  ['zoom'],
  ZOOM_LOCAL,
  0,
  ZOOM_LOCAL + 0.4,
  0.92,
]

function anelHexagono(lat, lon, raioMetros) {
  const raioLat = raioMetros / 110540
  const cosseno = Math.max(Math.abs(Math.cos((lat * Math.PI) / 180)), 1e-9)
  const raioLon = raioMetros / (111320 * cosseno)
  const anel = []
  for (let indice = 0; indice < 6; indice += 1) {
    const angulo = (2 * Math.PI * indice) / 6
    anel.push([
      lon + raioLon * Math.cos(angulo),
      lat + raioLat * Math.sin(angulo),
    ])
  }
  anel.push(anel[0])
  return anel
}

// Converte a lista de locais (já agregada pelo backend) em features com uma
// coluna hexagonal: raio e altura saem do total de votos do local.
export function colecaoLocais(locais) {
  const lista = Array.isArray(locais) ? locais : []
  let maior = 0
  for (const local of lista) {
    if (Number(local.total) > maior) maior = Number(local.total)
  }

  const features = lista.map((local) => {
    const fracao =
      maior > 0 ? Math.sqrt(Math.max(Number(local.total) || 0, 0) / maior) : 0
    const raio = Math.round(60 + 240 * fracao)
    const altura = Math.round(60 + 900 * fracao)

    return {
      type: 'Feature',
      id: String(local.nr_local),
      properties: {
        nr_local: local.nr_local,
        total: local.total,
        vv: local.vv,
        lider: local.lider,
        lider_cod: local.lider_cod,
        partido_lider: local.partido_lider || '',
        lider_pct: local.lider_pct,
        margem_votos: local.margem_votos,
        margem_pct: local.margem_pct,
        pct_apurado: local.pct_apurado,
        secoes_apuradas: local.secoes_apuradas,
        secoes_esperadas: local.secoes_esperadas,
        agrupado: Boolean(local.agrupado),
        nr_locais: Array.isArray(local.nr_locais) ? local.nr_locais : [],
        secao: Array.isArray(local.secoes) ? local.secoes.length : 0,
        altura_m: altura,
        raio_m: raio,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [anelHexagono(Number(local.lat), Number(local.lon), raio)],
      },
    }
  })

  return { type: 'FeatureCollection', features }
}

// Uma feature Point por local agrupado. É esta coleção que alimenta o cluster
// e os ícones de urna (o polígono acima fica só para o prisma 3D).
export function colecaoLocaisPontos(locais) {
  const lista = Array.isArray(locais) ? locais : []

  const features = lista
    .map((local) => ({
      type: 'Feature',
      id: String(local.nr_local),
      properties: {
        nr_local: local.nr_local,
        total: local.total,
        vv: local.vv,
        v13: local.v13,
        v22: local.v22,
        voutros: local.voutros,
        lider: local.lider,
        lider_cod: local.lider_cod,
        partido_lider: local.partido_lider || '',
        lider_pct: local.lider_pct,
        margem_votos: local.margem_votos,
        margem_pct: local.margem_pct,
        pct_apurado: local.pct_apurado,
        secoes_apuradas: local.secoes_apuradas,
        secoes_esperadas: local.secoes_esperadas,
        agrupado: Boolean(local.agrupado),
        nr_locais: Array.isArray(local.nr_locais) ? local.nr_locais : [],
        secao: Array.isArray(local.secoes) ? local.secoes.length : 0,
      },
      geometry: {
        type: 'Point',
        coordinates: [Number(local.lon), Number(local.lat)],
      },
    }))
    .filter(
      (feature) =>
        Number.isFinite(feature.geometry.coordinates[0]) &&
        Number.isFinite(feature.geometry.coordinates[1]),
    )

  return { type: 'FeatureCollection', features }
}

function limitesDaGeometria(geometria) {
  if (!geometria?.coordinates) return null
  let oeste = Infinity
  let sul = Infinity
  let leste = -Infinity
  let norte = -Infinity

  function visitar(coordenadas) {
    if (!Array.isArray(coordenadas)) return
    if (typeof coordenadas[0] === 'number' && typeof coordenadas[1] === 'number') {
      const [lon, lat] = coordenadas
      if (lon < oeste) oeste = lon
      if (lat < sul) sul = lat
      if (lon > leste) leste = lon
      if (lat > norte) norte = lat
      return
    }
    for (const item of coordenadas) visitar(item)
  }

  visitar(geometria.coordinates)
  if (!Number.isFinite(oeste)) return null
  return [
    [oeste, sul],
    [leste, norte],
  ]
}

function limitesDaColecao(geojson) {
  let oeste = Infinity
  let sul = Infinity
  let leste = -Infinity
  let norte = -Infinity

  for (const feature of geojson?.features || []) {
    const caixa = limitesDaGeometria(feature.geometry)
    if (!caixa) continue
    if (caixa[0][0] < oeste) oeste = caixa[0][0]
    if (caixa[0][1] < sul) sul = caixa[0][1]
    if (caixa[1][0] > leste) leste = caixa[1][0]
    if (caixa[1][1] > norte) norte = caixa[1][1]
  }

  if (!Number.isFinite(oeste)) return null
  return [
    [oeste, sul],
    [leste, norte],
  ]
}

function paddingDoMapa() {
  if (typeof window !== 'undefined' && window.innerWidth <= 820) {
    return {
      top: 52,
      right: 24,
      bottom: Math.round(window.innerHeight * 0.72),
      left: 24,
    }
  }
  return { top: 64, right: 64, bottom: 64, left: 64 }
}

function preencherTooltipUf(elemento, propriedades) {
  elemento.replaceChildren()

  const titulo = document.createElement('strong')
  titulo.textContent = `${propriedades.uf} · ${propriedades.nome}`

  const lider = document.createElement('span')
  lider.textContent = `${propriedades.lider} (${propriedades.partido_lider || '—'})`

  const margem = document.createElement('span')
  margem.className = 'uf-tooltip-margem'
  margem.textContent = `margem ${pontos(propriedades.margem_pct)} pts · ${percentual(
    propriedades.lider_pct,
  )}`

  elemento.append(titulo, lider, margem)
}

function preencherTooltipZona(elemento, propriedades) {
  elemento.replaceChildren()

  const titulo = document.createElement('strong')
  titulo.textContent = `${propriedades.municipio || 'município'} · zona ${propriedades.zona}`

  const lider = document.createElement('span')
  lider.textContent = `${propriedades.lider} (${propriedades.partido_lider || '—'})`

  const margem = document.createElement('span')
  margem.className = 'uf-tooltip-margem'
  margem.textContent = `margem ${pontos(propriedades.margem_pct)} pts · ${percentual(
    propriedades.lider_pct,
  )}`

  const votos = document.createElement('span')
  votos.textContent = `${numero(propriedades.total)} votos · ${numero(
    propriedades.secoes,
  )} seções`

  elemento.append(titulo, lider, margem, votos)
}

function preencherTooltipMunicipio(elemento, propriedades) {
  elemento.replaceChildren()

  const titulo = document.createElement('strong')
  titulo.textContent = propriedades.nome || 'município'

  const lider = document.createElement('span')
  lider.textContent = `${propriedades.lider} (${propriedades.partido_lider || '—'})`

  const margem = document.createElement('span')
  margem.className = 'uf-tooltip-margem'
  margem.textContent = `margem ${pontos(propriedades.margem_pct)} pts · ${percentual(
    propriedades.lider_pct,
  )}`

  const votos = document.createElement('span')
  votos.textContent = `${numero(propriedades.vv)} válidos · ${numero(
    propriedades.total,
  )} votos`

  elemento.append(titulo, lider, margem, votos)
}

function preencherTooltipLocal(elemento, propriedades) {
  elemento.replaceChildren()

  const titulo = document.createElement('strong')
  const grupo = Array.isArray(propriedades.nr_locais)
    ? propriedades.nr_locais.length
    : 0
  titulo.textContent =
    propriedades.agrupado && grupo > 1
      ? `local ${propriedades.nr_local ?? '—'} · grupo de ${grupo} locais`
      : `local ${propriedades.nr_local ?? '—'}`

  const lider = document.createElement('span')
  const pctLider = Number(propriedades.lider_pct)
  lider.textContent = `${propriedades.lider || '—'} (${propriedades.partido_lider || '—'})${
    Number.isFinite(pctLider) ? ` · ${percentual(pctLider)}` : ''
  }`

  const margem = document.createElement('span')
  margem.className = 'uf-tooltip-margem'
  margem.textContent = `margem ${pontos(propriedades.margem_pct)} pts`

  const apurado = document.createElement('span')
  const pctApurado = Number(propriedades.pct_apurado)
  apurado.className = 'uf-tooltip-margem'
  apurado.textContent = Number.isFinite(pctApurado)
    ? `${percentual(pctApurado, 1)} apurado · ${numero(
        propriedades.secoes_apuradas,
      )} de ${numero(propriedades.secoes_esperadas)} seções`
    : '—'

  const votos = document.createElement('span')
  votos.textContent = `${numero(propriedades.total)} votos · ${numero(
    propriedades.secao,
  )} seções`

  elemento.append(titulo, lider, margem, apurado, votos)
}

function featureDeDetalhe(evento, zoom) {
  const features = evento.features || []
  const municipio = features.find(
    (feature) => feature.layer?.id === LAYER_MUN_FILL,
  )
  const zona = features.find((feature) => feature.layer?.id === LAYER_ZONAS)

  if (zoom >= 6.6) {
    if (municipio) return municipio
    if (zoom < 8.4) return zona || null
    return null
  }
  if (zoom >= 4.6) return zona || municipio || null
  return null
}

function contarFonte(mapa, fonte) {
  try {
    return mapa.querySourceFeatures(fonte).length
  } catch {
    return 0
  }
}

function contarCamada(mapa, camada) {
  if (!mapa.getLayer(camada)) return 0
  try {
    return mapa.queryRenderedFeatures({ layers: [camada] }).length
  } catch {
    return 0
  }
}

function publicarDebug(mapa, locais, detalhe, municipioSelecionado) {
  let debug = {
    featuresUfs: 0,
    featuresMunicipios: 0,
    featuresZonas: 0,
    featuresLocais: 0,
    featuresLocaisPontos: 0,
    clustersVisiveis: 0,
    featuresLocaisPrisma: 0,
    camadasLocais: 0,
    locaisNoMunicipio: 0,
    detalheAtivo: Boolean(detalhe),
    municipioSelecionado: municipioSelecionado
      ? String(municipioSelecionado.codarea ?? municipioSelecionado)
      : null,
    nivel: 0,
    zoom: 0,
    pitch: 0,
    centro: [0, 0],
  }
  if (!mapa) {
    window.__mapaDebug = debug
    return
  }
  const numero = (fn) => {
    try {
      return fn()
    } catch {
      return 0
    }
  }
  try {
    debug = {
      featuresUfs: numero(() => contarFonte(mapa, FONTE)),
      featuresMunicipios: numero(() => contarFonte(mapa, FONTE_MUNICIPIOS)),
      featuresZonas: numero(() => contarFonte(mapa, FONTE_ZONAS)),
      featuresLocais: numero(() => contarFonte(mapa, FONTE_LOCAIS)),
      featuresLocaisPontos: numero(() => contarFonte(mapa, FONTE_LOCAIS_PONTOS)),
      clustersVisiveis: numero(() => contarCamada(mapa, LAYER_LOCAL_CLUSTER)),
      featuresLocaisPrisma: numero(() => contarFonte(mapa, FONTE_LOCAIS)),
      camadasLocais: numero(
        () =>
          [
            LAYER_LOCAL_PRISMA,
            LAYER_LOCAL_CLUSTER,
            LAYER_LOCAL_CLUSTER_COUNT,
            LAYER_LOCAL_PONTO,
            LAYER_LOCAL_HIT,
            LAYER_LOCAL_SELECIONADO,
          ].filter((camada) => Boolean(mapa.getLayer(camada))).length,
      ),
      locaisNoMunicipio: Array.isArray(locais) ? locais.length : 0,
      detalheAtivo: Boolean(detalhe),
      municipioSelecionado: municipioSelecionado
        ? String(municipioSelecionado.codarea ?? municipioSelecionado)
        : null,
      nivel: numero(() => nivelPorZoom(mapa.getZoom())),
      zoom: numero(() => Number(mapa.getZoom().toFixed(2))),
      pitch: numero(() => Number(mapa.getPitch().toFixed(1))),
      centro: numero(() => {
        const centro = mapa.getCenter()
        return [
          Number(centro.lng.toFixed(3)),
          Number(centro.lat.toFixed(3)),
        ]
      }),
    }
  } catch {
    // Mantém os valores padrão (0) para os campos que falharem.
  }
  window.__mapaDebug = debug
}

// O prisma é o indicador do nível de cidade. No nível de urna ele cobre o
// ícone de % apurado, então a camada só aparece entre ZOOM_LOCAL e 12 (antes
// do clusterMaxZoom) e enquanto a quantidade de locais couber no orçamento.
function atualizarVisibilidadePrisma(mapa, quantidade) {
  if (!mapa || !mapa.getLayer(LAYER_LOCAL_PRISMA)) return
  const total = Number(quantidade) || 0
  const zoom = mapa.getZoom()
  const visivel =
    total > 0 &&
    total <= LIMITE_LOCAIS_PRISMA &&
    zoom >= ZOOM_LOCAL &&
    zoom < 12
  mapa.setLayoutProperty(
    LAYER_LOCAL_PRISMA,
    'visibility',
    visivel ? 'visible' : 'none',
  )
}

function colecaoVazia() {
  return { type: 'FeatureCollection', features: [] }
}

// addLayer só é válido com o estilo pronto; se falhar, a intenção de reaplicar
// fica guardada para o próximo load/styledata. O warn traz o id da camada
// que faltou, em vez de engolir a exceção.
const camadasComAviso = new Set()
const fontesComAviso = new Set()

function adicionarCamada(mapa, definicao, aoPendente) {
  if (mapa.getLayer(definicao.id)) return true
  try {
    mapa.addLayer(definicao)
    return true
  } catch (erro) {
    // Um único aviso por camada: o retry é por evento (load/styledata), não
    // um laço de frames que encheria o console.
    if (!camadasComAviso.has(definicao.id)) {
      camadasComAviso.add(definicao.id)
      console.warn(
        `MapView: falha ao criar a camada "${definicao.id}"; nova tentativa no próximo load/styledata.`,
        erro,
      )
    }
    aoPendente?.()
    return false
  }
}

// addSource também depende do estilo montado. Mesmo tratamento da camada:
// falha vira aviso único + reaplicação agendada, nunca exceção solta no evento.
function adicionarFonte(mapa, id, definicao, aoPendente) {
  if (mapa.getSource(id)) return true
  try {
    mapa.addSource(id, definicao)
    return true
  } catch (erro) {
    if (!fontesComAviso.has(id)) {
      fontesComAviso.add(id)
      console.warn(
        `MapView: falha ao criar a fonte "${id}"; nova tentativa no próximo load/styledata.`,
        erro,
      )
    }
    aoPendente?.()
    return false
  }
}

function removerDetalhe(mapa) {
  for (const camada of [
    LAYER_LOCAL_SELECIONADO,
    LAYER_LOCAL_HIT,
    LAYER_LOCAL_PONTO,
    LAYER_LOCAL_CLUSTER_COUNT,
    LAYER_LOCAL_CLUSTER,
    LAYER_LOCAL_PRISMA,
    LAYER_MUN_LABELS,
    LAYER_MUN_LINE,
    LAYER_MUN_FILL,
    LAYER_ZONAS,
  ]) {
    if (mapa.getLayer(camada)) mapa.removeLayer(camada)
  }
  for (const fonte of [
    FONTE_LOCAIS_PONTOS,
    FONTE_LOCAIS,
    FONTE_ZONAS,
    FONTE_MUNICIPIOS,
  ]) {
    if (mapa.getSource(fonte)) mapa.removeSource(fonte)
  }
}

function aplicarDetalhe(
  mapa,
  detalhe,
  locais,
  aoPendente,
  temSelecao,
  municipioSelecionado,
) {
  if (!mapa) return
  // O gate certo para addSource/addLayer é a existência do estilo, não o
  // isStyleLoaded(): com o basemap CARTO abortando requests o estilo fica
  // eternamente "não carregado", mas já aceita fontes e camadas.
  if (!mapa.getStyle || !mapa.getStyle()) {
    aoPendente?.()
    return
  }

  if (!detalhe) {
    // Durante o recarregamento do detalhe o município continua selecionado e o
    // que está na tela é a última versão válida. Nunca apagar as camadas nesse
    // intervalo: o load/styledata pode reaplicar com detalhe=null antes de os
    // novos dados chegarem.
    if (!temSelecao) {
      removerDetalhe(mapa)
      publicarDebug(mapa, locais, null, null)
    } else {
      publicarDebug(mapa, locais, null, municipioSelecionado)
    }
    return
  }

  const municipiosGeo = detalhe.municipiosGeo || colecaoVazia()
  const zonasGeo = detalhe.zonasGeo || colecaoVazia()

  const fonteMunicipios = mapa.getSource(FONTE_MUNICIPIOS)
  if (fonteMunicipios) fonteMunicipios.setData(municipiosGeo)
  else {
    adicionarFonte(
      mapa,
      FONTE_MUNICIPIOS,
      {
        type: 'geojson',
        data: municipiosGeo,
        promoteId: 'codarea',
      },
      aoPendente,
    )
  }

  const fonteZonas = mapa.getSource(FONTE_ZONAS)
  if (fonteZonas) fonteZonas.setData(zonasGeo)
  else {
    adicionarFonte(
      mapa,
      FONTE_ZONAS,
      {
        type: 'geojson',
        data: zonasGeo,
      },
      aoPendente,
    )
  }

  // A ordem importa: prismas abaixo do preenchimento municipal e os rótulos
  // por cima de todas as camadas de detalhe.
  adicionarCamada(
    mapa,
    {
      id: LAYER_ZONAS,
      type: 'fill-extrusion',
      source: FONTE_ZONAS,
      minzoom: 4.6,
      paint: {
        'fill-extrusion-color': COR_ZONA,
        'fill-extrusion-height': ALTURA_PRISMAS,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': OPACIDADE_PRISMAS,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_MUN_FILL,
      type: 'fill',
      source: FONTE_MUNICIPIOS,
      minzoom: 6.6,
      paint: {
        'fill-color': EXPRESSAO_COR,
        'fill-opacity': OPACIDADE_MUNICIPIOS,
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_MUN_LINE,
      type: 'line',
      source: FONTE_MUNICIPIOS,
      minzoom: 6.6,
      layout: {
        'line-join': 'round',
      },
      paint: {
        'line-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          '#10161f',
          'rgba(255, 255, 255, 0.92)',
        ],
        'line-opacity': OPACIDADE_MUNICIPIOS_LINHA,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          6.6,
          0.4,
          9,
          1.1,
        ],
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_MUN_LABELS,
      type: 'symbol',
      source: FONTE_MUNICIPIOS,
      // Só entra depois que a altura dos prismas chega a zero (8.2): assim
      // nenhum nome cai atrás de uma coluna 3D.
      minzoom: ZOOM_ROTULO_MUNICIPIO,
      layout: {
        'text-field': ['get', 'nome'],
        'text-font': ['Montserrat SemiBold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 7.2, 9, 9, 11.5, 12, 14],
        'text-allow-overlap': false,
        'text-ignore-placement': false,
        'text-padding': 6,
        // Municípios com mais votos têm prioridade na colocação; quem não couber
        // sai inteiro, nunca pela metade.
        'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'total'], 0]],
        'symbol-z-order': 'source',
      },
      paint: {
        'text-color': '#1c232b',
        'text-halo-color': 'rgba(255, 253, 248, 0.94)',
        'text-halo-width': 1.4,
        'text-opacity': 0.92,
      },
    },
    aoPendente,
  )

  aplicarLocais(mapa, locais, aoPendente, detalhe, municipioSelecionado)
  publicarDebug(mapa, locais, detalhe, municipioSelecionado)
}

// Camadas do nível urna. A lista de locais já vem agregada pelo backend
// (/api/uf/{UF}/locais?cd=); aqui só se monta geometria e estilo.
function aplicarLocais(mapa, locais, aoPendente, detalhe, municipioSelecionado) {
  if (!mapa) return
  if (!mapa.getStyle || !mapa.getStyle()) {
    aoPendente?.()
    return
  }

  const lista = Array.isArray(locais) ? locais : []
  const colecaoPoligonos = colecaoLocais(lista)
  const colecaoPontos = colecaoLocaisPontos(lista)

  const fonteLocais = mapa.getSource(FONTE_LOCAIS)
  if (fonteLocais) fonteLocais.setData(colecaoPoligonos)
  else {
    adicionarFonte(
      mapa,
      FONTE_LOCAIS,
      {
        type: 'geojson',
        data: colecaoPoligonos,
      },
      aoPendente,
    )
  }

  const fontePontos = mapa.getSource(FONTE_LOCAIS_PONTOS)
  if (fontePontos) fontePontos.setData(colecaoPontos)
  else {
    adicionarFonte(
      mapa,
      FONTE_LOCAIS_PONTOS,
      {
        type: 'geojson',
        data: colecaoPontos,
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 48,
      },
      aoPendente,
    )
  }

  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_PRISMA,
      type: 'fill-extrusion',
      source: FONTE_LOCAIS,
      minzoom: ZOOM_LOCAL,
      paint: {
        'fill-extrusion-color': COR_PRISMA_LOCAL,
        'fill-extrusion-height': ALTURA_LOCAL,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': OPACIDADE_LOCAL,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_CLUSTER,
      type: 'circle',
      source: FONTE_LOCAIS_PONTOS,
      minzoom: ZOOM_LOCAL,
      filter: ['has', 'cluster'],
      paint: {
        'circle-color': '#2b3440',
        'circle-radius': [
          'step',
          ['get', 'point_count'],
          18,
          10,
          24,
          50,
          32,
        ],
        'circle-stroke-color': '#fffdf8',
        'circle-stroke-width': 2,
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_CLUSTER_COUNT,
      type: 'symbol',
      source: FONTE_LOCAIS_PONTOS,
      minzoom: ZOOM_LOCAL,
      filter: ['has', 'cluster'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': ['Montserrat SemiBold'],
        'text-size': 11,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#ffffff',
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_PONTO,
      type: 'symbol',
      source: FONTE_LOCAIS_PONTOS,
      minzoom: ZOOM_LOCAL,
      filter: ['!', ['has', 'cluster']],
      layout: {
        'icon-image': [
          'concat',
          'local-',
          [
            'to-string',
            [
              '*',
              10,
              ['floor', ['/', ['coalesce', ['get', 'pct_apurado'], 100], 10]],
            ],
          ],
          '-',
          [
            'case',
            ['==', ['coalesce', ['get', 'partido_lider'], ''], ''],
            'NEUTRO',
            ['get', 'partido_lider'],
          ],
        ],
        'icon-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          9.2,
          0.28,
          12,
          0.5,
          14,
          0.62,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    aoPendente,
  )

  // Alvo de toque maior que o ícone desenhado (dedo no celular). A opacidade
  // não pode ser 0: o MapLibre descarta a feature do hit-test e o clique no
  // local deixa de abrir o cartão.
  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_HIT,
      type: 'circle',
      source: FONTE_LOCAIS_PONTOS,
      minzoom: ZOOM_LOCAL,
      filter: ['!', ['has', 'cluster']],
      paint: {
        'circle-color': '#000000',
        'circle-opacity': 0.01,
        'circle-radius': 18,
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_SELECIONADO,
      type: 'circle',
      source: FONTE_LOCAIS_PONTOS,
      minzoom: ZOOM_LOCAL,
      filter: ['==', ['get', 'nr_local'], -1],
      paint: {
        'circle-color': 'rgba(0, 0, 0, 0)',
        'circle-radius': 13,
        'circle-stroke-color': '#10161f',
        'circle-stroke-width': 2.2,
      },
    },
    aoPendente,
  )

  // Se uma tentativa parcial criou o hit antes do ponto, o retry não pode
  // inverter a ordem: o alvo transparente tem de continuar acima do ícone.
  if (
    typeof mapa.getStyle === 'function' &&
    typeof mapa.moveLayer === 'function' &&
    mapa.getLayer(LAYER_LOCAL_HIT) &&
    mapa.getLayer(LAYER_LOCAL_PONTO) &&
    mapa.getStyle()
  ) {
    const ordem = mapa.getStyle().layers.map((camada) => camada.id)
    if (ordem.indexOf(LAYER_LOCAL_HIT) < ordem.indexOf(LAYER_LOCAL_PONTO)) {
      if (mapa.getLayer(LAYER_LOCAL_SELECIONADO)) {
        mapa.moveLayer(LAYER_LOCAL_HIT, LAYER_LOCAL_SELECIONADO)
      } else {
        mapa.moveLayer(LAYER_LOCAL_HIT)
      }
    }
  }

  // Acima do limite a coluna por local perde utilidade (e custa GPU); a partir
  // do zoom 12 ela também cobriria o ícone de % apurado do nível de urna.
  atualizarVisibilidadePrisma(mapa, lista.length)
  // Publica o debug já com as camadas criadas nesta passagem.
  publicarDebug(mapa, lista, detalhe, municipioSelecionado)
}

export default function MapView({
  geojson,
  selectedUf,
  onSelect,
  onMapError,
  detalhe,
  municipioSelecionado,
  locais,
  localSelecionado,
  zoomInicial,
  onZoom,
  onSelectMunicipio,
  onSelectLocal,
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const estiloCarregadoRef = useRef(false)
  const geojsonRef = useRef(geojson)
  const selectedRef = useRef(selectedUf)
  const onSelectRef = useRef(onSelect)
  const onMapErrorRef = useRef(onMapError)
  const detalheRef = useRef(detalhe)
  const municipioSelecionadoRef = useRef(municipioSelecionado)
  const zoomInicialRef = useRef(zoomInicial)
  const onZoomRef = useRef(onZoom)
  const onSelectMunicipioRef = useRef(onSelectMunicipio)
  const locaisRef = useRef(locais)
  const onSelectLocalRef = useRef(onSelectLocal)
  const localSelecionadoRef = useRef(localSelecionado)
  const hoverRef = useRef(null)
  const selecionadoRef = useRef(null)
  const municipioRef = useRef(null)
  const zoomInicialAplicadoRef = useRef(false)
  const municipioZoomUrlRef = useRef(null)
  const reaplicarDetalheRef = useRef(null)

  geojsonRef.current = geojson
  selectedRef.current = selectedUf
  onSelectRef.current = onSelect
  onMapErrorRef.current = onMapError
  detalheRef.current = detalhe
  municipioSelecionadoRef.current = municipioSelecionado
  zoomInicialRef.current = zoomInicial
  onZoomRef.current = onZoom
  onSelectMunicipioRef.current = onSelectMunicipio
  locaisRef.current = locais
  onSelectLocalRef.current = onSelectLocal
  localSelecionadoRef.current = localSelecionado

  // Cria o mapa uma única vez.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    let mapa
    try {
      mapa = new maplibregl.Map({
        container,
        style: CARTO_POSITRON,
        center: [-52.5, -15.2],
        zoom: 3.1,
        minZoom: 2.2,
        maxZoom: 14,
        attributionControl: false,
        dragRotate: true,
        touchZoomRotate: true,
        pitchWithRotate: true,
      })
    } catch (erro) {
      console.error('Falha ao iniciar o MapLibre:', erro)
      onMapErrorRef.current?.()
      return undefined
    }

    mapRef.current = mapa
    // Handle para as provas (scripts/provas/captura.mjs) forçarem resize +
    // repaint: em GPU de software o canvas pode ficar sem frame após o fit.
    window.__mapa = mapa

    // O basemap pode terminar de carregar depois do load e um style swap apaga
    // as imagens; re-registrar apenas os ids ausentes é idempotente.
    mapa.on('styledata', () => {
      // A própria registrarIconesLocais já decide pelo isStyleLoaded (addImage
      // exige o estilo assentado); aqui não se descarta a chamada por isso.
      registrarIconesLocais(mapa)
    })

    const compacto = window.matchMedia('(max-width: 820px)').matches
    mapa.addControl(
      new maplibregl.AttributionControl({ compact: compacto }),
      'bottom-right',
    )
    mapa.addControl(
      new maplibregl.NavigationControl({ showCompass: true }),
      'top-right',
    )

    const tooltipEl = document.createElement('div')
    tooltipEl.className = 'uf-tooltip'
    const tooltip = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
      className: 'uf-tooltip-popup',
    }).setDOMContent(tooltipEl)

    const podeHover = window.matchMedia(
      '(hover: hover) and (pointer: fine)',
    ).matches

    function limparHover() {
      if (hoverRef.current == null) return
      mapa.setFeatureState(
        { source: FONTE, id: hoverRef.current },
        { hover: false },
      )
      hoverRef.current = null
    }

    function aplicarSelecao(uf) {
      if (!mapa.getSource(FONTE)) return
      if (selecionadoRef.current != null) {
        mapa.setFeatureState(
          { source: FONTE, id: selecionadoRef.current },
          { selected: false },
        )
      }
      selecionadoRef.current = uf || null
      if (uf) {
        mapa.setFeatureState({ source: FONTE, id: uf }, { selected: true })
      }
    }

    function atualizarDebug() {
      publicarDebug(
        mapa,
        locaisRef.current,
        detalheRef.current,
        municipioSelecionadoRef.current,
      )
    }

    // Se o detalhe chegou antes do estilo estar pronto (ou uma camada falhou),
    // a reaplicação é agendada por evento (load/styledata) e coalescida por um
    // debounce de 150ms para não repetir a cada tile. As funções são
    // idempotentes.
    let reaplicacaoAgendada = null
    let reagendamentoIdle = null
    let reagendamentoIdleUsado = false

    function reaplicarDetalhe() {
      if (reaplicacaoAgendada != null) return
      reaplicacaoAgendada = window.setTimeout(() => {
        reaplicacaoAgendada = null
        // Sempre lê o estado mais recente no momento da chamada: o evento de
        // load/styledata pode disparar durante o recarregamento do município.
        const detalheAtual = detalheRef.current
        const locaisAtuais = locaisRef.current
        const municipioAtual = municipioSelecionadoRef.current
        const temSelecao = Boolean(municipioAtual)

        if (!detalheAtual && temSelecao) {
          // O detalhe ainda não voltou, mas há município selecionado: preserva
          // as camadas da última aplicação válida e tenta de novo no próximo
          // idle, uma única vez.
          if (!reagendamentoIdleUsado && reagendamentoIdle == null) {
            reagendamentoIdleUsado = true
            reagendamentoIdle = () => {
              reagendamentoIdle = null
              reaplicarDetalhe()
            }
            mapa.once('idle', reagendamentoIdle)
          }
          atualizarDebug()
          return
        }

        reagendamentoIdleUsado = false
        if (reagendamentoIdle != null) {
          mapa.off('idle', reagendamentoIdle)
          reagendamentoIdle = null
        }
        aplicarDetalhe(
          mapa,
          detalheAtual,
          locaisAtuais,
          reaplicarDetalhe,
          temSelecao,
          municipioAtual,
        )
        atualizarDebug()
      }, 150)
    }

    reaplicarDetalheRef.current = reaplicarDetalhe
    mapa.on('load', reaplicarDetalhe)
    mapa.on('styledata', reaplicarDetalhe)

    mapa.on('load', () => {
      estiloCarregadoRef.current = true
      registrarIconesLocais(mapa)
      mapa.addSource(FONTE, {
        type: 'geojson',
        data: geojsonRef.current,
        promoteId: 'uf',
      })

      mapa.addLayer({
        id: LAYER_FILL,
        type: 'fill',
        source: FONTE,
        paint: {
          'fill-color': EXPRESSAO_COR,
          'fill-opacity': 0.85,
        },
      })

      mapa.addLayer({
        id: LAYER_LINE,
        type: 'line',
        source: FONTE,
        paint: {
          'line-color': 'rgba(255, 255, 255, 0.94)',
          'line-width': 1,
        },
      })

      mapa.addLayer({
        id: LAYER_HOVER,
        type: 'line',
        source: FONTE,
        paint: {
          'line-color': '#18222e',
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            2.4,
            0,
          ],
        },
      })

      mapa.addLayer({
        id: LAYER_SELECTED,
        type: 'line',
        source: FONTE,
        paint: {
          'line-color': '#10161f',
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            3,
            0,
          ],
        },
      })

      mapa.addLayer({
        id: 'ufs-labels',
        type: 'symbol',
        source: FONTE,
        minzoom: 3,
        layout: {
          'text-field': ['get', 'uf'],
          'text-font': ['Montserrat SemiBold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 9, 5, 12, 7, 14],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-padding': 2,
        },
        paint: {
          'text-color': '#1c232b',
          'text-halo-color': 'rgba(255, 253, 248, 0.94)',
          'text-halo-width': 1.4,
          'text-opacity': 0.92,
        },
      })

      // Com UF inicial vinda da URL, o fitBounds da seleção já rodou e não
      // pode ser sobrescrito pelo enquadramento do Brasil.
      if (!selectedRef.current) {
        const limites = limitesDaColecao(geojsonRef.current)
        if (limites) {
          mapa.fitBounds(limites, {
            padding: { top: 24, right: 24, bottom: 24, left: 24 },
            maxZoom: 4.2,
            duration: 0,
          })
        }
      }

      aplicarSelecao(selectedRef.current)
      aplicarDetalhe(
        mapa,
        detalheRef.current,
        locaisRef.current,
        reaplicarDetalhe,
        Boolean(municipioSelecionadoRef.current),
        municipioSelecionadoRef.current,
      )
      atualizarDebug()
      onZoomRef.current?.(mapa.getZoom())
    })

    if (podeHover) {
      mapa.on('mousemove', LAYER_FILL, (evento) => {
        const feature = evento.features?.[0]
        if (!feature) return
        const id = feature.id

        if (hoverRef.current !== id) {
          limparHover()
          hoverRef.current = id
          mapa.setFeatureState({ source: FONTE, id }, { hover: true })
        }

        mapa.getCanvas().style.cursor = 'pointer'
        preencherTooltipUf(tooltipEl, feature.properties || {})
        tooltip.setLngLat(evento.lngLat).addTo(mapa)
      })

      mapa.on('mouseleave', LAYER_FILL, () => {
        limparHover()
        mapa.getCanvas().style.cursor = ''
        tooltip.remove()
      })

      mapa.on('mousemove', [LAYER_ZONAS, LAYER_MUN_FILL], (evento) => {
        const feature = featureDeDetalhe(evento, mapa.getZoom())
        if (!feature) return

        limparHover()
        mapa.getCanvas().style.cursor = 'pointer'
        if (feature.layer.id === LAYER_MUN_FILL) {
          preencherTooltipMunicipio(tooltipEl, feature.properties || {})
        } else {
          preencherTooltipZona(tooltipEl, feature.properties || {})
        }
        tooltip.setLngLat(evento.lngLat).addTo(mapa)
      })

      mapa.on('mouseleave', [LAYER_ZONAS, LAYER_MUN_FILL], () => {
        mapa.getCanvas().style.cursor = ''
        tooltip.remove()
      })

      mapa.on('mousemove', [LAYER_LOCAL_HIT, LAYER_LOCAL_PONTO], (evento) => {
        if (mapa.getZoom() < ZOOM_LOCAL) return
        const feature = evento.features?.[0]
        if (!feature) return
        mapa.getCanvas().style.cursor = 'pointer'
        preencherTooltipLocal(tooltipEl, feature.properties || {})
        tooltip.setLngLat(evento.lngLat).addTo(mapa)
      })

      mapa.on('mouseleave', [LAYER_LOCAL_HIT, LAYER_LOCAL_PONTO], () => {
        mapa.getCanvas().style.cursor = ''
        tooltip.remove()
      })
    }

    mapa.on('click', LAYER_FILL, (evento) => {
      // No nível urna o clique é do ponto/cluster, não da UF.
      if (mapa.getZoom() >= ZOOM_LOCAL) return
      const feature = evento.features?.[0]
      if (feature?.properties?.uf) {
        onSelectRef.current?.(feature.properties.uf)
      }
    })

    mapa.on('click', LAYER_MUN_FILL, (evento) => {
      // No nível urna o clique é do local, não do município.
      if (mapa.getZoom() >= ZOOM_LOCAL) return
      const feature = evento.features?.[0]
      if (!feature) return
      const propriedades = feature.properties || {}

      preencherTooltipMunicipio(tooltipEl, propriedades)
      tooltip.setLngLat(evento.lngLat).addTo(mapa)

      onSelectMunicipioRef.current?.(
        propriedades.nome,
        String(propriedades.codarea),
      )

      // O feature devolvido pelo MapLibre pode vir recortado pela tile; para
      // enquadrar o município inteiro usamos a geometria completa da fonte.
      const completa = detalheRef.current?.municipiosGeo?.features?.find(
        (item) => String(item.properties?.codarea) === String(propriedades.codarea),
      )
      const limites = limitesDaGeometria(completa?.geometry || feature.geometry)
      if (limites) {
        mapa.fitBounds(limites, {
          padding: paddingDoMapa(),
          maxZoom: 9.5,
          duration: 850,
        })
      }
    })

    mapa.on('click', LAYER_ZONAS, (evento) => {
      // A partir do zoom municipal o preenchimento cobre os prismas e o
      // clique deve abrir o município, não a zona.
      if (mapa.getZoom() >= 6.6) return
      const feature = evento.features?.[0]
      if (!feature) return

      preencherTooltipZona(tooltipEl, feature.properties || {})
      tooltip.setLngLat(evento.lngLat).addTo(mapa)
    })

    // Cluster de locais: dois passos de zoom aproximam até o nível de rua.
    mapa.on('click', LAYER_LOCAL_CLUSTER, (evento) => {
      const feature = evento.features?.[0]
      const coordenadas = feature?.geometry?.coordinates
      if (!coordenadas) return
      evento.preventDefault?.()
      mapa.easeTo({
        center: coordenadas,
        zoom: Math.min(mapa.getZoom() + 2, 14),
        duration: 600,
      })
    })

    // Nível urna: o clique/toque abre o local e a lista de seções dele. A
    // agregação é do backend; aqui só se identifica o nr_local.
    mapa.on('click', LAYER_LOCAL_HIT, (evento) => {
      if (mapa.getZoom() < ZOOM_LOCAL) return
      const feature = evento.features?.[0]
      if (!feature) return
      evento.preventDefault?.()
      const nrLocal = Number(feature.properties?.nr_local)
      if (!Number.isFinite(nrLocal)) return
      onSelectLocalRef.current?.(nrLocal)
    })

    mapa.on('idle', () => {
      // Os ícones dos locais eram registrados só no load/styledata com a guarda
      // isStyleLoaded(): no celular o load chegava com o estilo ainda não
      // assentado e nenhum styledata posterior vinha, então
      // hasImage('local-100-PT') ficava false e a camada locais-ponto não
      // desenhava nada (medido: imagens=0 por 10s, ponto=0 em todos os
      // paddings). O idle chega depois de tiles/glyphs; hasImage torna a
      // chamada idempotente e barata.
      registrarIconesLocais(mapa)
      atualizarDebug()
    })
    mapa.on('sourcedata', (evento) => {
      if (
        evento.sourceId === FONTE ||
        evento.sourceId === FONTE_MUNICIPIOS ||
        evento.sourceId === FONTE_ZONAS ||
        evento.sourceId === FONTE_LOCAIS ||
        evento.sourceId === FONTE_LOCAIS_PONTOS
      ) {
        atualizarDebug()
      }
    })
    mapa.on('moveend', () => {
      atualizarVisibilidadePrisma(
        mapa,
        Array.isArray(locaisRef.current) ? locaisRef.current.length : 0,
      )
      atualizarDebug()
      onZoomRef.current?.(mapa.getZoom())
    })

    const aoPerderContexto = () => {
      console.error('Contexto WebGL perdido.')
      onMapErrorRef.current?.()
    }
    mapa.getCanvas().addEventListener('webglcontextlost', aoPerderContexto)

    const observador = new ResizeObserver(() => mapa.resize())
    observador.observe(container)

    return () => {
      observador.disconnect()
      if (reaplicacaoAgendada != null) {
        window.clearTimeout(reaplicacaoAgendada)
        reaplicacaoAgendada = null
      }
      if (reagendamentoIdle != null) {
        mapa.off('idle', reagendamentoIdle)
        reagendamentoIdle = null
      }
      reagendamentoIdleUsado = false
      reaplicarDetalheRef.current = null
      mapa.getCanvas().removeEventListener('webglcontextlost', aoPerderContexto)
      tooltip.remove()
      mapa.remove()
      mapRef.current = null
      estiloCarregadoRef.current = false
      delete window.__mapaDebug
      delete window.__mapa
    }
  }, [])

  // Mantém o source sincronizado caso os dados sejam recarregados.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa || !geojson) return undefined

    const aplicar = () => {
      const fonte = mapa.getSource(FONTE)
      if (fonte) fonte.setData(geojson)
    }

    // Aplica já (as funções internas só dependem de getStyle) e reaplica no
    // load caso as camadas base ainda não existam. isStyleLoaded() não serve
    // de gate aqui: com o basemap abortando requests ele fica falso para sempre.
    aplicar()
    if (!estiloCarregadoRef.current) mapa.once('load', aplicar)

    return () => {
      mapa.off('load', aplicar)
    }
  }, [geojson])

  // Cria/atualiza as fontes e camadas municipais/zonais/urnas quando chegam.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return undefined

    // Recarregando o detalhe do município: não tocar no mapa, senão as
    // camadas válidas da seleção atual seriam apagadas.
    if (municipioSelecionado && !detalhe) return undefined

    const aplicar = () => {
      const detalheAtual = detalheRef.current
      const municipioAtual = municipioSelecionadoRef.current
      if (municipioAtual && !detalheAtual) return
      aplicarDetalhe(
        mapa,
        detalheAtual,
        locaisRef.current,
        reaplicarDetalheRef.current,
        Boolean(municipioAtual),
        municipioAtual,
      )
    }
    // Aplica já (as funções internas só dependem de getStyle) e reaplica no
    // load caso as camadas base ainda não existam. isStyleLoaded() não serve
    // de gate aqui: com o basemap abortando requests ele fica falso para sempre.
    aplicar()
    if (!estiloCarregadoRef.current) mapa.once('load', aplicar)

    return () => {
      mapa.off('load', aplicar)
    }
  }, [detalhe, municipioSelecionado, locais, localSelecionado])

  // Anel em volta do local escolhido.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa || !mapa.getLayer(LAYER_LOCAL_SELECIONADO)) return
    const nrLocal = localSelecionado
      ? Number(localSelecionado.nr_local ?? localSelecionado)
      : -1
    mapa.setFilter(
      LAYER_LOCAL_SELECIONADO,
      ['==', ['get', 'nr_local'], Number.isFinite(nrLocal) ? nrLocal : -1],
    )
  }, [localSelecionado, locais])

  // O coroplético de UF só esmaece quando existe UF selecionada e o detalhe
  // municipal já foi carregado.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return undefined

    const aplicar = () => {
      if (!mapa.getLayer(LAYER_FILL)) return
      mapa.setPaintProperty(
        LAYER_FILL,
        'fill-opacity',
        selectedUf && detalhe ? OPACIDADE_UFS_COM_DETALHE : 0.85,
      )
    }

    // Aplica já (as funções internas só dependem de getStyle) e reaplica no
    // load caso as camadas base ainda não existam. isStyleLoaded() não serve
    // de gate aqui: com o basemap abortando requests ele fica falso para sempre.
    aplicar()
    if (!estiloCarregadoRef.current) mapa.once('load', aplicar)

    return () => {
      mapa.off('load', aplicar)
    }
  }, [selectedUf, detalhe])

  // Destaque do estado selecionado via feature-state.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return
    if (!mapa.getSource(FONTE)) return

    if (selecionadoRef.current != null) {
      mapa.setFeatureState(
        { source: FONTE, id: selecionadoRef.current },
        { selected: false },
      )
    }
    selecionadoRef.current = selectedUf || null
    if (selectedUf) {
      mapa.setFeatureState(
        { source: FONTE, id: selectedUf },
        { selected: true },
      )
    }
  }, [selectedUf])

  // Contorno do município escolhido no painel.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa || !mapa.getSource(FONTE_MUNICIPIOS)) return

    if (municipioRef.current != null) {
      mapa.setFeatureState(
        { source: FONTE_MUNICIPIOS, id: municipioRef.current },
        { selected: false },
      )
    }
    municipioRef.current = municipioSelecionado
      ? String(municipioSelecionado.codarea)
      : null
    if (municipioRef.current) {
      mapa.setFeatureState(
        { source: FONTE_MUNICIPIOS, id: municipioRef.current },
        { selected: true },
      )
    }
  }, [municipioSelecionado, detalhe])

  // Aproxima a UF escolhida, inclina a câmera para os prismas e aplica o zoom
  // inicial da URL uma única vez, depois do fitBounds.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return undefined

    if (!selectedUf) {
      mapa.easeTo({ pitch: 0, bearing: 0, duration: 650 })
      return undefined
    }
    if (!geojson) return undefined

    const feature = geojson.features?.find(
      (item) => item.properties?.uf === selectedUf,
    )
    const limites = limitesDaGeometria(feature?.geometry)
    if (!limites) return undefined

    mapa.fitBounds(limites, {
      padding: paddingDoMapa(),
      maxZoom: 8.2,
      duration: 850,
    })

    let concluido = false
    let reserva = null

    const concluirAproximacao = () => {
      if (concluido) return
      concluido = true
      mapa.off('moveend', concluirAproximacao)
      if (reserva != null) window.clearTimeout(reserva)

      const zoomBruto = zoomInicialRef.current
      const zoom = Number(zoomBruto)
      if (
        zoomBruto != null &&
        zoomBruto !== '' &&
        Number.isFinite(zoom) &&
        !zoomInicialAplicadoRef.current
      ) {
        zoomInicialAplicadoRef.current = true
        mapa.jumpTo({ zoom })
      }

      // No celular o bottom sheet cobre ~72% da tela e quem resolve isso é o
      // padding assimétrico do fitBounds (paddingDoMapa: bottom = 72%). Não há
      // panBy manual aqui: jumpTo/easeTo preservam o enquadramento já corrigido,
      // e o pan extra empurrava o alvo para fora do canvas (medido: ?z=13 abria
      // em lat -4.224, ~55 km ao sul de Fortaleza, tela sem local nenhum).
      const pitch = window.innerWidth <= 820 ? 30 : 50
      mapa.easeTo({ pitch, bearing: 0, duration: 850 })
    }

    const reservarConclusao = () => {
      reserva = window.setTimeout(() => {
        if (concluido) return
        // Não interrompe uma animação de fitBounds ainda em andamento (o
        // frame pode demorar em GPUs de software).
        if (mapa.isMoving()) {
          reservarConclusao()
          return
        }
        concluirAproximacao()
      }, 3000)
    }

    mapa.once('moveend', concluirAproximacao)
    reservarConclusao()

    return () => {
      if (reserva != null) window.clearTimeout(reserva)
      mapa.off('moveend', concluirAproximacao)
    }
  }, [selectedUf, geojson])

  // Atalho de URL (?m=<cd_tse>&z=): enquadra o município e aplica o zoom pedido
  // uma única vez, depois que a animação de enquadramento da UF assentar.
  useEffect(() => {
    const mapa = mapRef.current
    const zoom = Number(zoomInicialRef.current)
    const bruto = zoomInicialRef.current
    if (!mapa || !municipioSelecionado || !detalhe) return undefined
    if (bruto == null || bruto === '' || !Number.isFinite(zoom)) return undefined

    const chave = String(municipioSelecionado.codarea)
    if (municipioZoomUrlRef.current === chave) return undefined

    const feature = detalhe.municipiosGeo?.features?.find(
      (item) => String(item.properties?.codarea) === chave,
    )
    const limites = limitesDaGeometria(feature?.geometry)
    if (!limites) return undefined

    const aplicar = () => {
      municipioZoomUrlRef.current = chave
      zoomInicialAplicadoRef.current = true
      mapa.fitBounds(limites, {
        padding: paddingDoMapa(),
        maxZoom: 13,
        duration: 0,
      })
      // O fitBounds com padding assimétrico (celular: bottom 72%) deixa a
      // câmera ao SUL do município para a cidade aparecer na faixa acima do
      // bottom sheet. Ao subir o zoom por deep link (?z=) manter aquele centro
      // jogava a cidade para fora da tela: medido no celular, ?z=13 abria em
      // lat -4.224 e desenhava 0 locais dos 196. Com o zoom aplicado, o centro
      // passa a ser o centro do município, que é o que o deep link pede.
      if (zoom > mapa.getZoom()) {
        const centroMunicipio = [
          (limites[0][0] + limites[1][0]) / 2,
          (limites[0][1] + limites[1][1]) / 2,
        ]
        mapa.jumpTo({ zoom, center: centroMunicipio })
      }
      mapa.easeTo({
        pitch: window.innerWidth <= 820 ? 30 : 50,
        bearing: 0,
        duration: 350,
      })
    }

    if (mapa.isMoving()) mapa.once('idle', aplicar)
    else aplicar()

    return () => {
      mapa.off('idle', aplicar)
    }
  }, [municipioSelecionado, detalhe])

  return <div className="map-canvas" ref={containerRef} />
}
