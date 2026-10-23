import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import MapView from './MapView.jsx'
import NationalScoreboard from './NationalScoreboard.jsx'
import PlacarBarra from './PlacarBarra.jsx'
import PlacarGaveta from './PlacarGaveta.jsx'
import DetailCard from './DetailCard.jsx'
import MunicipioCard from './MunicipioCard.jsx'
import LocalCard from './LocalCard.jsx'
import Legend, { ResumoLideres } from './Legend.jsx'
import FallbackView from './FallbackView.jsx'
import ReplayBar from './ReplayBar.jsx'
import MargensCard from './MargensCard.jsx'
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
  municipioInicial,
  zoomInicial,
  replayInicial,
  margemInicial,
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
  const [locais, setLocais] = useState(null)
  const [totalLocais, setTotalLocais] = useState(0)
  const [locaisCarregando, setLocaisCarregando] = useState(false)
  const [localSelecionado, setLocalSelecionado] = useState(null)
  // Gaveta do placar no celular: nasce no estado `is-peek` (~70 px) e só abre
  // por toque no resumo — o mapa fica com o resto da tela.
  const [gavetaAberta, setGavetaAberta] = useState(false)
  const [zoom, setZoom] = useState(() => {
    if (zoomInicial == null || zoomInicial === '') return 3.1
    const inicial = Number(zoomInicial)
    return Number.isFinite(inicial) ? inicial : 3.1
  })

  const painelRef = useRef(null)
  const sheetBodyRef = useRef(null)
  const cacheDetalheRef = useRef(new Map())

  // ---------------------------------------------------------------------
  // REPLAY e MARGENS. Os dois são modos de leitura do mesmo mapa: o replay
  // troca o que a UF pinta (concreto até fechar 100%), e o mapa de calor de
  // margem troca a rampa de cor. Nada disso altera dado do pleito atual.
  // `?replay=<frame>` e `?margem=1` são atalhos de prova/drill-down.
  const indiceInicial =
    replayInicial == null || replayInicial === '' ? NaN : Number(replayInicial)
  const [replayAberto, setReplayAberto] = useState(Number.isFinite(indiceInicial))
  const [replay, setReplay] = useState(null)
  const [replayCarregando, setReplayCarregando] = useState(false)
  const [replayErro, setReplayErro] = useState(null)
  const [indiceReplay, setIndiceReplay] = useState(
    Number.isFinite(indiceInicial) && indiceInicial > 0 ? Math.round(indiceInicial) - 1 : 0,
  )
  const [tocando, setTocando] = useState(false)

  const [margensAberto, setMargensAberto] = useState(Boolean(margemInicial))
  const [margens, setMargens] = useState(null)
  const [margensCarregando, setMargensCarregando] = useState(false)
  const [margensErro, setMargensErro] = useState(null)

  useEffect(() => {
    if (!replayAberto || replay || replayCarregando) return undefined
    let ativo = true
    setReplayCarregando(true)
    setReplayErro(null)
    fetchJSON(`${API_BASE}/replay?modo=2022`)
      .then((resposta) => {
        if (!ativo) return
        if (!resposta?.disponivel) {
          setReplayErro(resposta?.nota || 'série histórica indisponível')
          setReplayCarregando(false)
          return
        }
        setReplay(resposta)
        setReplayCarregando(false)
      })
      .catch(() => {
        if (!ativo) return
        setReplayErro('não foi possível carregar a série do replay')
        setReplayCarregando(false)
      })
    return () => {
      ativo = false
    }
  }, [replayAberto, replay, replayCarregando])

  useEffect(() => {
    if (!margensAberto || margens || margensCarregando) return undefined
    let ativo = true
    setMargensCarregando(true)
    setMargensErro(null)
    fetchJSON(`${API_BASE}/margens`)
      .then((resposta) => {
        if (!ativo) return
        if (resposta?.erro) {
          setMargensErro(String(resposta.erro))
          setMargensCarregando(false)
          return
        }
        setMargens(resposta)
        setMargensCarregando(false)
      })
      .catch(() => {
        if (!ativo) return
        setMargensErro('não foi possível carregar o painel de margens')
        setMargensCarregando(false)
      })
    return () => {
      ativo = false
    }
  }, [margensAberto, margens, margensCarregando])

  // Play do replay: um frame a cada 260 ms; para no último (o arquivo fechado).
  useEffect(() => {
    if (!tocando) return undefined
    const total = replay?.frames?.length || 0
    if (total === 0) return undefined
    const relogio = setInterval(() => {
      setIndiceReplay((atual) => {
        if (atual >= total - 1) {
          setTocando(false)
          return total - 1
        }
        return atual + 1
      })
    }, 260)
    return () => clearInterval(relogio)
  }, [tocando, replay])

  const frameReplay = useMemo(() => {
    const frames = replay?.frames || []
    if (!replayAberto || frames.length === 0) return null
    const posicao = Math.min(Math.max(indiceReplay, 0), frames.length - 1)
    return { frame: frames[posicao], base: replay.ufs_base || {} }
  }, [replayAberto, replay, indiceReplay])

  const alternarReplay = () => {
    setReplayAberto((aberto) => {
      if (aberto) setTocando(false)
      return !aberto
    })
  }


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

  const voltarAoEstado = () => {
    setLocalSelecionado(null)
    setMunicipioSelecionado(null)
  }

  // cd_tse do município escolhido (a API de locais usa o código do TSE).
  const cdTse = municipioDetalhe?.cd_tse ?? null

  // Locais de votação do município: agregados no backend, uma UF/município por
  // vez. Nunca se baixa a lista de locais da UF inteira no front.
  useEffect(() => {
    if (!ufSelecionada || !cdTse) {
      setLocais(null)
      setTotalLocais(0)
      setLocalSelecionado(null)
      return undefined
    }

    let ativo = true
    setLocais(null)
    setTotalLocais(0)
    setLocalSelecionado(null)
    setLocaisCarregando(true)

    fetchJSON(`${API_BASE}/uf/${ufSelecionada}/locais?cd=${cdTse}`)
      .then((resposta) => {
        if (!ativo) return
        setLocais(Array.isArray(resposta.locais) ? resposta.locais : [])
        setTotalLocais(Number(resposta.total_locais) || 0)
        setLocaisCarregando(false)
      })
      .catch(() => {
        if (!ativo) return
        setLocais(null)
        setLocaisCarregando(false)
      })

    return () => {
      ativo = false
    }
  }, [ufSelecionada, cdTse])

  // Atalho de prova/drill-down: ?m=<cd_tse> abre o município assim que a malha
  // municipal da UF chega.
  useEffect(() => {
    if (!municipioInicial || !detalhe) return
    const codigo = String(municipioInicial)
    const lista = detalhe.municipios?.municipios || []
    const achado = lista.find((item) => String(item.cd_tse) === codigo)
    if (achado) {
      setMunicipioSelecionado({
        nome: achado.nome,
        codarea: String(achado.cd_ibge),
        cd_tse: achado.cd_tse,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [municipioInicial, detalhe])

  const localDetalhe = useMemo(() => {
    if (localSelecionado == null || !Array.isArray(locais)) return null
    return (
      locais.find(
        (item) => String(item.nr_local) === String(localSelecionado),
      ) || null
    )
  }, [localSelecionado, locais])

  const selecionarUf = (uf) => {
    setMunicipioSelecionado(null)
    setUfSelecionada(uf)
  }

  const selecionarMunicipio = (nome, codarea) => {
    setLocalSelecionado(null)
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
          locais={locais}
          localSelecionado={localSelecionado}
          zoomInicial={zoomInicial}
          onZoom={setZoom}
          onSelectMunicipio={selecionarMunicipio}
          onSelectLocal={setLocalSelecionado}
          replay={frameReplay}
          modoMargem={!replayAberto && margensAberto}
        />
        <PlacarBarra estados={estados} />
        <div className="modos-mapa" role="group" aria-label="Modos de leitura do mapa">
          <button
            type="button"
            className={`modos-btn${replayAberto ? ' is-ativo' : ''}`}
            onClick={alternarReplay}
            aria-pressed={replayAberto}
            data-prova="modo-replay"
          >
            replay 2022
          </button>
          <button
            type="button"
            className={`modos-btn${margensAberto ? ' is-ativo' : ''}`}
            onClick={() => setMargensAberto((valor) => !valor)}
            aria-pressed={margensAberto}
            data-prova="modo-margem"
          >
            margem
          </button>
        </div>
        {replayAberto ? (
          <ReplayBar
            replay={replay}
            indice={indiceReplay}
            tocando={tocando}
            carregando={replayCarregando}
            erro={replayErro}
            onIndice={setIndiceReplay}
            onPlayPause={() => setTocando((valor) => !valor)}
            onFechar={alternarReplay}
          />
        ) : null}
        <Legend zoom={zoom} />
      </main>

      <aside className="side-panel" ref={painelRef} aria-label="Painel da apuração">
        {margensAberto ? (
          <MargensCard
            margens={margens}
            carregando={margensCarregando}
            erro={margensErro}
            onFechar={() => setMargensAberto(false)}
          />
        ) : null}

        <NationalScoreboard estados={estados} variante="panel" />

        <div className="panel-divider" aria-hidden="true" />

        {localDetalhe ? (
          <LocalCard
            local={localDetalhe}
            uf={ufSelecionada}
            municipio={municipioDetalhe?.nome}
            totalLocais={totalLocais}
            onVoltar={() => setLocalSelecionado(null)}
          />
        ) : municipioDetalhe ? (
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

      <PlacarGaveta
        estados={estados}
        aberta={gavetaAberta}
        onToggle={() => setGavetaAberta((valor) => !valor)}
      />

      <section
        className={`bottom-sheet sheet-detalhe mobile-only${selecionada ? ' is-open' : ''}`}
        aria-label="Detalhes da seleção no mapa"
        aria-hidden={!selecionada}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-header">
          <div className="sheet-header-texto">
            <span className="sheet-header-kicker">
              {localDetalhe
                ? 'local de votação'
                : municipioDetalhe
                  ? 'município'
                  : 'estado selecionado'}
            </span>
            <strong className="sheet-header-titulo">
              {localDetalhe
                ? `Local ${localDetalhe.nr_local ?? '—'}`
                : municipioDetalhe?.nome || selecionada?.nome || 'seleção'}
            </strong>
          </div>
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
          {localDetalhe ? (
            <LocalCard
              local={localDetalhe}
              uf={ufSelecionada}
              municipio={municipioDetalhe?.nome}
              totalLocais={totalLocais}
              onVoltar={() => setLocalSelecionado(null)}
            />
          ) : municipioDetalhe ? (
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

      <section
        className={`bottom-sheet sheet-margens mobile-only${margensAberto ? ' is-open' : ''}`}
        aria-label="De onde está ganhando"
        aria-hidden={!margensAberto}
      >
        <div className="sheet-grip" aria-hidden="true" />
        {margensAberto ? (
          <div className="sheet-body sheet-body--margens">
            <MargensCard
              margens={margens}
              carregando={margensCarregando}
              erro={margensErro}
              onFechar={() => setMargensAberto(false)}
            />
          </div>
        ) : null}
      </section>
    </div>
  )
}
