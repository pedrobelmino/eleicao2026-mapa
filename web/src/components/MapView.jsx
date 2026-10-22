import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import {
  CARTO_POSITRON,
  EXPRESSAO_COR,
} from '../mapa.js'
import { percentual, pontos } from '../format.js'

const FONTE = 'ufs'
const LAYER_FILL = 'ufs-fill'
const LAYER_LINE = 'ufs-line'
const LAYER_HOVER = 'ufs-hover'
const LAYER_SELECTED = 'ufs-selected'

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

function preencherTooltip(elemento, propriedades) {
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

export default function MapView({
  geojson,
  selectedUf,
  onSelect,
  onMapError,
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const geojsonRef = useRef(geojson)
  const selectedRef = useRef(selectedUf)
  const onSelectRef = useRef(onSelect)
  const onMapErrorRef = useRef(onMapError)
  const hoverRef = useRef(null)
  const selecionadoRef = useRef(null)

  geojsonRef.current = geojson
  selectedRef.current = selectedUf
  onSelectRef.current = onSelect
  onMapErrorRef.current = onMapError

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
        maxZoom: 12,
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

    mapa.on('load', () => {
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

      const limites = limitesDaColecao(geojsonRef.current)
      if (limites) {
        mapa.fitBounds(limites, {
          padding: { top: 24, right: 24, bottom: 24, left: 24 },
          maxZoom: 4.2,
          duration: 0,
        })
      }

      aplicarSelecao(selectedRef.current)
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
        preencherTooltip(tooltipEl, feature.properties || {})
        tooltip.setLngLat(evento.lngLat).addTo(mapa)
      })

      mapa.on('mouseleave', LAYER_FILL, () => {
        limparHover()
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
    }
  }, [])

  // Mantém o source sincronizado caso os dados sejam recarregados.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa || !geojson) return

    const aplicar = () => {
      const fonte = mapa.getSource(FONTE)
      if (fonte) fonte.setData(geojson)
    }

    if (mapa.isStyleLoaded()) aplicar()
    else mapa.once('load', aplicar)

    return () => {
      mapa.off('load', aplicar)
    }
  }, [geojson])

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

  // Aproxima o estado escolhido, deixando espaço para o cartão/bottom sheet.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa || !selectedUf || !geojson) return

    const feature = geojson.features?.find(
      (item) => item.properties?.uf === selectedUf,
    )
    const limites = limitesDaGeometria(feature?.geometry)
    if (!limites) return

    const celular = window.innerWidth <= 820
    mapa.fitBounds(limites, {
      padding: celular
        ? {
            top: 52,
            right: 24,
            bottom: Math.round(window.innerHeight * 0.72),
            left: 24,
          }
        : { top: 64, right: 64, bottom: 64, left: 64 },
      maxZoom: 6.4,
      duration: 850,
    })
  }, [selectedUf, geojson])

  return <div className="map-canvas" ref={containerRef} />
}
