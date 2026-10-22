import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import MapView from './MapView.jsx'
import NationalScoreboard from './NationalScoreboard.jsx'
import DetailCard from './DetailCard.jsx'
import Legend, { ResumoLideres } from './Legend.jsx'
import FallbackView from './FallbackView.jsx'
import { indexarUFs, resumoLideres } from '../dados.js'

function suportaWebGL() {
  try {
    // maplibregl.supported() existia em versões anteriores do MapLibre.
    // Mantemos a chamada quando disponível e, nas versões novas, fazemos a
    // mesma checagem de contexto WebGL diretamente.
    if (typeof maplibregl.supported === 'function') {
      return maplibregl.supported()
    }
    const canvas = document.createElement('canvas')
    const contexto =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')
    return Boolean(contexto)
  } catch {
    return false
  }
}

function EmptyDetail({ resumo }) {
  return (
    <div className="detail-empty">
      <span className="empty-compass" aria-hidden="true">
        ↗
      </span>
      <strong>Escolha um estado no mapa</strong>
      <p>
        Clique ou toque em uma UF para ver o líder, a margem em votos e em
        pontos, os votos válidos e os dois primeiros colocados.
      </p>
      <ResumoLideres resumo={resumo} />
    </div>
  )
}

export default function MapWorkspace({ estados, geojson }) {
  const [webgl] = useState(suportaWebGL)
  const [mapaFalhou, setMapaFalhou] = useState(false)
  const [ufSelecionada, setUfSelecionada] = useState(null)
  const painelRef = useRef(null)
  const sheetBodyRef = useRef(null)

  const ufs = useMemo(() => indexarUFs(estados, geojson), [estados, geojson])
  const resumo = useMemo(() => resumoLideres(ufs), [ufs])
  const selecionada = ufSelecionada ? ufs.get(ufSelecionada) : null

  const fechar = () => setUfSelecionada(null)

  useEffect(() => {
    if (!ufSelecionada) return undefined
    const aoTeclar = (evento) => {
      if (evento.key === 'Escape') setUfSelecionada(null)
    }
    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [ufSelecionada])

  useEffect(() => {
    if (!ufSelecionada) return
    if (window.innerWidth > 820) {
      painelRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    } else if (sheetBodyRef.current) {
      sheetBodyRef.current.scrollTop = 0
    }
  }, [ufSelecionada])

  if (!webgl || mapaFalhou) {
    return <FallbackView ufs={ufs} estados={estados} resumo={resumo} />
  }

  return (
    <div className={`workspace${selecionada ? ' tem-selecao' : ''}`}>
      <main className="map-stage">
        <MapView
          geojson={geojson}
          selectedUf={ufSelecionada}
          onSelect={setUfSelecionada}
          onMapError={() => setMapaFalhou(true)}
        />
        <Legend />
      </main>

      <aside className="side-panel" ref={painelRef} aria-label="Painel da apuração">
        <NationalScoreboard estados={estados} variante="panel" />

        <div className="panel-divider" aria-hidden="true" />

        {selecionada ? (
          <DetailCard uf={selecionada} onClose={fechar} />
        ) : (
          <EmptyDetail resumo={resumo} />
        )}

        <p className="panel-foot">
          Dados públicos do TSE. Sem cookies, sem IP, sem rastreamento.
        </p>
      </aside>

      <div
        className={`sheet-scrim mobile-only${selecionada ? ' is-open' : ''}`}
        onClick={fechar}
        aria-hidden="true"
      />

      <section
        className={`bottom-sheet mobile-only${selecionada ? ' is-open' : ''}`}
        aria-label="Detalhes do estado selecionado"
        aria-hidden={!selecionada}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-header">
          <NationalScoreboard estados={estados} variante="sheet" />
          <button
            type="button"
            className="sheet-close"
            onClick={fechar}
            aria-label="Fechar detalhes do estado"
          >
            ×
          </button>
        </div>
        <div className="sheet-body" ref={sheetBodyRef}>
          {selecionada ? (
            <DetailCard
              uf={selecionada}
              onClose={fechar}
              mostrarFechar={false}
            />
          ) : null}
        </div>
      </section>
    </div>
  )
}
