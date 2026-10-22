import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import {
  CARTO_POSITRON,
  CORES_PARTIDO,
  COR_NEUTRA,
  EXPRESSAO_COR,
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

const OPACIDADE_PRISMAS = [
  'interpolate',
  ['linear'],
  ['zoom'],
  5.0,
  0,
  6.2,
  0.9,
  7.4,
  0.9,
  7.8,
  0.25,
  8.4,
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

function publicarDebug(mapa) {
  if (!mapa) return
  const centro = mapa.getCenter()
  window.__mapaDebug = {
    featuresUfs: contarFonte(mapa, FONTE),
    featuresMunicipios: contarFonte(mapa, FONTE_MUNICIPIOS),
    featuresZonas: contarFonte(mapa, FONTE_ZONAS),
    zoom: Number(mapa.getZoom().toFixed(2)),
    pitch: Number(mapa.getPitch().toFixed(1)),
    centro: [Number(centro.lng.toFixed(3)), Number(centro.lat.toFixed(3))],
  }
}

function colecaoVazia() {
  return { type: 'FeatureCollection', features: [] }
}

function removerDetalhe(mapa) {
  for (const camada of [
    LAYER_MUN_LABELS,
    LAYER_MUN_LINE,
    LAYER_MUN_FILL,
    LAYER_ZONAS,
  ]) {
    if (mapa.getLayer(camada)) mapa.removeLayer(camada)
  }
  for (const fonte of [FONTE_ZONAS, FONTE_MUNICIPIOS]) {
    if (mapa.getSource(fonte)) mapa.removeSource(fonte)
  }
}

function aplicarDetalhe(mapa, detalhe) {
  if (!mapa) return

  if (!detalhe) {
    removerDetalhe(mapa)
    publicarDebug(mapa)
    return
  }

  const municipiosGeo = detalhe.municipiosGeo || colecaoVazia()
  const zonasGeo = detalhe.zonasGeo || colecaoVazia()

  const fonteMunicipios = mapa.getSource(FONTE_MUNICIPIOS)
  if (fonteMunicipios) fonteMunicipios.setData(municipiosGeo)
  else {
    mapa.addSource(FONTE_MUNICIPIOS, {
      type: 'geojson',
      data: municipiosGeo,
      promoteId: 'codarea',
    })
  }

  const fonteZonas = mapa.getSource(FONTE_ZONAS)
  if (fonteZonas) fonteZonas.setData(zonasGeo)
  else {
    mapa.addSource(FONTE_ZONAS, {
      type: 'geojson',
      data: zonasGeo,
    })
  }

  // A ordem importa: prismas abaixo do preenchimento municipal e os rótulos
  // por cima de todas as camadas de detalhe.
  if (!mapa.getLayer(LAYER_ZONAS)) {
    mapa.addLayer({
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
    })
  }

  if (!mapa.getLayer(LAYER_MUN_FILL)) {
    mapa.addLayer({
      id: LAYER_MUN_FILL,
      type: 'fill',
      source: FONTE_MUNICIPIOS,
      minzoom: 6.6,
      paint: {
        'fill-color': EXPRESSAO_COR,
        'fill-opacity': OPACIDADE_MUNICIPIOS,
      },
    })
  }

  if (!mapa.getLayer(LAYER_MUN_LINE)) {
    mapa.addLayer({
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
    })
  }

  if (!mapa.getLayer(LAYER_MUN_LABELS)) {
    mapa.addLayer({
      id: LAYER_MUN_LABELS,
      type: 'symbol',
      source: FONTE_MUNICIPIOS,
      minzoom: 7.2,
      layout: {
        'text-field': ['get', 'nome'],
        'text-font': ['Montserrat SemiBold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 7.2, 9, 9, 11.5, 12, 14],
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
  }

  publicarDebug(mapa)
}

export default function MapView({
  geojson,
  selectedUf,
  onSelect,
  onMapError,
  detalhe,
  municipioSelecionado,
  zoomInicial,
  onZoom,
  onSelectMunicipio,
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const estiloCarregadoRef = useRef(false)
  const geojsonRef = useRef(geojson)
  const selectedRef = useRef(selectedUf)
  const onSelectRef = useRef(onSelect)
  const onMapErrorRef = useRef(onMapError)
  const detalheRef = useRef(detalhe)
  const zoomInicialRef = useRef(zoomInicial)
  const onZoomRef = useRef(onZoom)
  const onSelectMunicipioRef = useRef(onSelectMunicipio)
  const hoverRef = useRef(null)
  const selecionadoRef = useRef(null)
  const municipioRef = useRef(null)
  const zoomInicialAplicadoRef = useRef(false)

  geojsonRef.current = geojson
  selectedRef.current = selectedUf
  onSelectRef.current = onSelect
  onMapErrorRef.current = onMapError
  detalheRef.current = detalhe
  zoomInicialRef.current = zoomInicial
  onZoomRef.current = onZoom
  onSelectMunicipioRef.current = onSelectMunicipio

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
      publicarDebug(mapa)
    }

    mapa.on('load', () => {
      estiloCarregadoRef.current = true
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
      aplicarDetalhe(mapa, detalheRef.current)
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
    }

    mapa.on('click', LAYER_FILL, (evento) => {
      const feature = evento.features?.[0]
      if (feature?.properties?.uf) {
        onSelectRef.current?.(feature.properties.uf)
      }
    })

    mapa.on('click', LAYER_MUN_FILL, (evento) => {
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

    mapa.on('idle', atualizarDebug)
    mapa.on('sourcedata', (evento) => {
      if (
        evento.sourceId === FONTE ||
        evento.sourceId === FONTE_MUNICIPIOS ||
        evento.sourceId === FONTE_ZONAS
      ) {
        atualizarDebug()
      }
    })
    mapa.on('moveend', () => {
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

    if (mapa.isStyleLoaded() || estiloCarregadoRef.current) aplicar()
    else mapa.once('load', aplicar)

    return () => {
      mapa.off('load', aplicar)
    }
  }, [geojson])

  // Cria/atualiza as fontes e camadas municipais/zonais quando o detalhe chega.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return undefined

    const aplicar = () => aplicarDetalhe(mapa, detalhe)
    if (mapa.isStyleLoaded() || estiloCarregadoRef.current) aplicar()
    else mapa.once('load', aplicar)

    return () => {
      mapa.off('load', aplicar)
    }
  }, [detalhe])

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

    if (mapa.isStyleLoaded() || estiloCarregadoRef.current) aplicar()
    else mapa.once('load', aplicar)

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
      const centroUf = [
        (limites[0][0] + limites[1][0]) / 2,
        (limites[0][1] + limites[1][1]) / 2,
      ]
      if (
        zoomBruto != null &&
        zoomBruto !== '' &&
        Number.isFinite(zoom) &&
        !zoomInicialAplicadoRef.current
      ) {
        zoomInicialAplicadoRef.current = true
        mapa.jumpTo({ zoom })
      }

      // No celular o bottom sheet cobre ~72% da tela: o centro do canvas fica
      // escondido atrás do sheet. Desloca o mapa para o centro da UF cair na
      // faixa visível acima do painel.
      if (window.innerWidth <= 820) {
        const preenchimento = paddingDoMapa()
        const faixa = window.innerHeight - preenchimento.top - preenchimento.bottom
        const alvoY = preenchimento.top + Math.max(faixa, 120) / 2
        const projetado = mapa.project(centroUf)
        mapa.panBy(
          [projetado.x - window.innerWidth / 2, projetado.y - alvoY],
          { duration: 0 },
        )
      }

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

  return <div className="map-canvas" ref={containerRef} />
}
