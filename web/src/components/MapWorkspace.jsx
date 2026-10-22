import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import MapView from './MapView.jsx'
import NationalScoreboard from './NationalScoreboard.jsx'
import DetailCard from './DetailCard.jsx'
import MunicipioCard from './MunicipioCard.jsx'
import Legend, { ResumoLideres } from './Legend.jsx'
import FallbackView from './FallbackView.jsx'
import { indexarUFs, resumoLideres } from '../dados.js'
import { API_BASE, fetchJSON } from '../api.js'

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

function AvisosDetalhe({ carregando, indisponivel, erro }) {
  if (!carregando && !indisponivel && !erro) return null
  return (
    <div className="mun-avisos">
      {carregando ? (
        <p className="mun-aviso">carregando municípios e zonas…</p>
      ) : null}
      {indisponivel ? (
        <p className="mun-aviso">
          malha municipal ainda não ingerida para esta UF
        </p>
      ) : null}
      {erro ? <p className="mun-aviso mun-aviso--erro">{erro}</p> : null}
    </div>
  )
}

export default function MapWorkspace({
  estados,
  geojson,
  ufInicial,
  zoomInicial,
}) {
  const [webgl] = useState(suportaWebGL)
  const [mapaFalhou, setMapaFalhou] = useState(false)
  const ufs = useMemo(() => indexarUFs(estados, geojson), [estados, geojson])
  const resumo = useMemo(() => resumoLideres(ufs), [ufs])

  const ufInicialNormalizada = ufInicial
    ? String(ufInicial).trim().toUpperCase()
    : null

  const [ufSelecionada, setUfSelecionada] = useState(() =>
    ufInicialNormalizada && ufs.has(ufInicialNormalizada)
      ? ufInicialNormalizada
      : null,
  )
  const [municipioSelecionado, setMunicipioSelecionado] = useState(null)
  const [detalhe, setDetalhe] = useState(null)
  const [detalheCarregando, setDetalheCarregando] = useState(false)
  const [detalheIndisponivel, setDetalheIndisponivel] = useState(false)
  const [erroDetalhe, setErroDetalhe] = useState(null)
  const [zoom, setZoom] = useState(() => {
    if (zoomInicial == null || zoomInicial === '') return 3.1
    const inicial = Number(zoomInicial)
    return Number.isFinite(inicial) ? inicial : 3.1
  })

  const painelRef = useRef(null)
  const sheetBodyRef = useRef(null)
  const cacheDetalheRef = useRef(new Map())

  const selecionada = ufSelecionada ? ufs.get(ufSelecionada) : null

  // Cache por UF: alternar a seleção não refaz os quatro downloads.
  useEffect(() => {
    if (!ufSelecionada) {
      setDetalhe(null)
      setDetalheCarregando(false)
      setDetalheIndisponivel(false)
      setErroDetalhe(null)
      setMunicipioSelecionado(null)
      return undefined
    }

    setMunicipioSelecionado(null)

    const cache = cacheDetalheRef.current
    if (cache.has(ufSelecionada)) {
      setDetalhe(cache.get(ufSelecionada))
      setDetalheCarregando(false)
      setDetalheIndisponivel(false)
      setErroDetalhe(null)
      return undefined
    }

    let ativo = true
    const base = `${API_BASE}/uf/${ufSelecionada}`

    setDetalhe(null)
    setDetalheCarregando(true)
    setDetalheIndisponivel(false)
    setErroDetalhe(null)

    Promise.all([
      fetchJSON(`${base}/municipios`),
      fetchJSON(`${base}/municipios.geojson`),
      fetchJSON(`${base}/zonas`),
      fetchJSON(`${base}/zonas.geojson`),
    ])
      .then(([municipios, municipiosGeo, zonas, zonasGeo]) => {
        if (!ativo) return
        const dados = { municipios, municipiosGeo, zonas, zonasGeo }
        cache.set(ufSelecionada, dados)
        setDetalhe(dados)
        setDetalheCarregando(false)
      })
      .catch((erro) => {
        if (!ativo) return
        setDetalheCarregando(false)
        if (erro?.status === 404) {
          setDetalheIndisponivel(true)
          setErroDetalhe(null)
        } else {
          setErroDetalhe('não foi possível carregar o detalhe desta UF')
        }
      })

    return () => {
      ativo = false
    }
  }, [ufSelecionada])

  const municipioDetalhe = useMemo(() => {
    if (!municipioSelecionado) return null
    if (!detalhe) return municipioSelecionado

    const codigo = String(municipioSelecionado.codarea ?? '')
    const lista = detalhe.municipios?.municipios || []
    const encontrado = lista.find(
      (municipio) =>
        String(municipio.cd_ibge) === codigo ||
        municipio.nome === municipioSelecionado.nome,
    )
    if (encontrado) return encontrado

    const feature = detalhe.municipiosGeo?.features?.find(
      (item) =>
        String(item.properties?.codarea) === codigo ||
        item.properties?.nome === municipioSelecionado.nome,
    )
    if (feature?.properties) return feature.properties

    return municipioSelecionado
  }, [municipioSelecionado, detalhe])

  const fechar = () => {
    setMunicipioSelecionado(null)
    setUfSelecionada(null)
  }

  const voltarAoEstado = () => setMunicipioSelecionado(null)

  const selecionarUf = (uf) => {
    setMunicipioSelecionado(null)
    setUfSelecionada(uf)
  }

  const selecionarMunicipio = (nome, codarea) => {
    setMunicipioSelecionado({ nome, codarea: String(codarea) })
  }

  useEffect(() => {
    if (!ufSelecionada && !municipioSelecionado) return undefined
    const aoTeclar = (evento) => {
      if (evento.key !== 'Escape') return
      if (municipioSelecionado) setMunicipioSelecionado(null)
      else setUfSelecionada(null)
    }
    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [ufSelecionada, municipioSelecionado])

  useEffect(() => {
    if (!ufSelecionada && !municipioSelecionado) return
    if (window.innerWidth > 820) {
      painelRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    } else if (sheetBodyRef.current) {
      sheetBodyRef.current.scrollTop = 0
    }
  }, [ufSelecionada, municipioSelecionado])

  if (!webgl || mapaFalhou) {
    return <FallbackView ufs={ufs} estados={estados} resumo={resumo} />
  }

  const avisos = (
    <AvisosDetalhe
      carregando={detalheCarregando}
      indisponivel={detalheIndisponivel}
      erro={erroDetalhe}
    />
  )

  return (
    <div className={`workspace${selecionada ? ' tem-selecao' : ''}`}>
      <main className="map-stage">
        <MapView
          geojson={geojson}
          selectedUf={ufSelecionada}
          onSelect={selecionarUf}
          onMapError={() => setMapaFalhou(true)}
          detalhe={detalhe}
          municipioSelecionado={municipioSelecionado}
          zoomInicial={zoomInicial}
          onZoom={setZoom}
          onSelectMunicipio={selecionarMunicipio}
        />
        <Legend zoom={zoom} />
      </main>

      <aside className="side-panel" ref={painelRef} aria-label="Painel da apuração">
        <NationalScoreboard estados={estados} variante="panel" />

        <div className="panel-divider" aria-hidden="true" />

        {municipioDetalhe ? (
          <MunicipioCard
            municipio={municipioDetalhe}
            uf={ufSelecionada}
            onVoltar={voltarAoEstado}
          />
        ) : selecionada ? (
          <>
            <DetailCard uf={selecionada} onClose={fechar} />
            {avisos}
          </>
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
        aria-label="Detalhes da seleção no mapa"
        aria-hidden={!selecionada}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-header">
          <NationalScoreboard estados={estados} variante="sheet" />
          <button
            type="button"
            className="sheet-close"
            onClick={fechar}
            aria-label="Fechar detalhes da seleção"
          >
            ×
          </button>
        </div>
        <div className="sheet-body" ref={sheetBodyRef}>
          {municipioDetalhe ? (
            <MunicipioCard
              municipio={municipioDetalhe}
              uf={ufSelecionada}
              onVoltar={voltarAoEstado}
            />
          ) : selecionada ? (
            <>
              <DetailCard
                uf={selecionada}
                onClose={fechar}
                mostrarFechar={false}
              />
              {avisos}
            </>
          ) : null}
        </div>
      </section>
    </div>
  )
}
