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
import ReplayBar, { relogioDoArquivo } from './ReplayBar.jsx'
import MargensCard from './MargensCard.jsx'
import { indexarUFs, resumoLideres } from '../dados.js'
import { API_BASE, fetchJSON } from '../api.js'
import { percentual } from '../format.js'

// Tempo por passo na velocidade 1x. 8x e 60x dividem esse intervalo.
const INTERVALO_BASE_MS = 700
const INTERVALO_MIN_MS = 12

// A série do replay chega em dois formatos e vira UM: uma lista de passos com
//   { i, t, pct, secoes, total, uf, placar: [{ nome, votos, pct }] }
//   - 2026 (dump do TSE por seção): `passos`, com votos por código de candidato;
//   - 2022 (série nacional oficial): `frames`, com os candidatos já no frame.
// O percentual do placar é recalculado sobre os votos VÁLIDOS do próprio passo:
// é o que faz a porcentagem do placar subir junto com a apuração.
function normalizarPassos(replay) {
  if (!replay) return []
  const candidatos = Array.isArray(replay.candidatos) ? replay.candidatos : []

  const comPercentual = (itens, validos) =>
    itens.map((item) => ({
      ...item,
      pct: validos > 0 ? (100 * item.votos) / validos : 0,
    }))

  if (Array.isArray(replay.passos) && replay.passos.length > 0) {
    return replay.passos.map((passo, indice) => {
      const votos = passo.votos || {}
      const itens = candidatos.map((candidato) => ({
        nome: candidato.nome,
        partido: candidato.partido || '',
        votos: Number(votos[candidato.codigo]) || 0,
      }))
      // Votos válidos do passo = os dois candidatos da base + os demais.
      const validos =
        itens.reduce((soma, item) => soma + item.votos, 0) + (Number(votos.outros) || 0)
      return {
        i: indice,
        t: passo.t || '',
        pct: Number(passo.pct_apurado) || 0,
        secoes: Number(passo.secoes_apuradas) || 0,
        total: Number(passo.secoes_total) || 0,
        uf: passo.uf || {},
        placar: comPercentual(itens, validos),
      }
    })
  }

  const frames = Array.isArray(replay.frames) ? replay.frames : []
  return frames.map((frame, indice) => {
    const itens = (frame.candidatos || []).map((candidato) => ({
      nome: candidato.nome,
      partido: candidato.partido || '',
      votos: Number(candidato.votos) || 0,
    }))
    const validos = itens.reduce((soma, item) => soma + item.votos, 0)
    return {
      i: indice,
      t: frame.em || '',
      pct: Number(frame.pct_apurado) || 0,
      secoes: Number(frame.secoes_apuradas) || 0,
      total: Number(frame.secoes_total) || 0,
      uf: frame.ufs || {},
      placar: comPercentual(itens, validos),
    }
  })
}

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

// Aviso de primeira visita no celular (24/10/2026): o /mapa foi desenhado para
// mouse e tela grande. O aviso é um card pequeno no topo, fechável, e a dispensa
// fica no localStorage — quem já leu não vê de novo. No desktop não existe.
const CHAVE_AVISO = 'mapa.avisoDesktop'

function avisoJaDispensado() {
  try {
    return window.localStorage.getItem(CHAVE_AVISO) === '1'
  } catch {
    return false
  }
}

function AvisoDesktop({ onDispensar }) {
  return (
    <div className="aviso-desktop mobile-only" role="status" data-prova="aviso-desktop">
      <p className="aviso-desktop-texto">
        <strong>Melhor experiência no desktop</strong> — no celular o mapa funciona
        com zoom, arraste e toque.
      </p>
      <button
        type="button"
        className="aviso-desktop-ok"
        onClick={onDispensar}
        data-prova="aviso-entendi"
      >
        Entendi
      </button>
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
  onAoVivo,
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
  // PAINEL DE DETALHES (celular): fechado é o PADRÃO — o mapa ocupa a tela e o
  // usuário só vê o botão flutuante. Quem abre é o botão (`detalheAberto`), não
  // a seleção: selecionar UF/município/local NÃO empurra painel para a tela.
  const [detalheAberto, setDetalheAberto] = useState(false)
  // Aviso de melhor experiência no desktop: só no celular e só até o "Entendi".
  const [celular, setCelular] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 820px)').matches,
  )
  const [avisoVisivel, setAvisoVisivel] = useState(() => !avisoJaDispensado())
  // Altura real do sheet de detalhe: o botão flutuante senta logo acima dele
  // quando o painel está aberto (ResizeObserver — nada estimado em CSS).
  const [alturaDetalhe, setAlturaDetalhe] = useState(0)
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
  const sheetDetalheRef = useRef(null)
  const cacheDetalheRef = useRef(new Map())
  const detalheArrasteRef = useRef(null)

  // Só o celular vê o aviso e o botão: a media query é a mesma do CSS (820px).
  useEffect(() => {
    const consulta = window.matchMedia('(max-width: 820px)')
    const aoMudar = (evento) => setCelular(evento.matches)
    consulta.addEventListener('change', aoMudar)
    return () => consulta.removeEventListener('change', aoMudar)
  }, [])

  const dispensarAviso = () => {
    setAvisoVisivel(false)
    try {
      window.localStorage.setItem(CHAVE_AVISO, '1')
    } catch {
      /* navegador em modo privado: o aviso volta na próxima visita */
    }
  }

  // Altura do sheet para o botão flutuante não cobrir o painel aberto.
  useEffect(() => {
    const alvo = sheetDetalheRef.current
    if (!alvo || typeof ResizeObserver === 'undefined') return undefined
    const observador = new ResizeObserver(() => {
      const medida = Math.round(alvo.getBoundingClientRect().height)
      setAlturaDetalhe((atual) => (atual === medida ? atual : medida))
    })
    observador.observe(alvo)
    return () => observador.disconnect()
  }, [])

  // ---------------------------------------------------------------------
  // REPLAY e MARGENS. Os dois são modos de leitura do mesmo mapa: o replay
  // troca o que a UF pinta (concreto até fechar 100%), e o mapa de calor de
  // margem troca a rampa de cor. Nada disso altera dado do pleito atual.
  // `?replay=<frame>` e `?margem=1` são atalhos de prova/drill-down.
  const indiceInicial =
    replayInicial == null || replayInicial === '' ? NaN : Number(replayInicial)
  const [replayAberto, setReplayAberto] = useState(Number.isFinite(indiceInicial))
  // Duas séries, mesmo desenho: `apuracao` (2026, passo a passo por seção) é o
  // padrão; `2022` é o arquivo histórico do TSE, com relógio real. Cada uma
  // fica em cache depois de baixada — trocar de fonte não refaz o download.
  const [fonte, setFonte] = useState('apuracao')
  const [replays, setReplays] = useState({})
  const [replayCarregando, setReplayCarregando] = useState(false)
  const [replayErro, setReplayErro] = useState(null)
  const [indiceReplay, setIndiceReplay] = useState(
    Number.isFinite(indiceInicial) && indiceInicial > 0 ? Math.round(indiceInicial) - 1 : 0,
  )
  const [tocando, setTocando] = useState(false)
  const [velocidade, setVelocidade] = useState(1)
  const replay = replays[fonte] || null

  const [margensAberto, setMargensAberto] = useState(Boolean(margemInicial))
  const [margens, setMargens] = useState(null)
  const [margensCarregando, setMargensCarregando] = useState(false)
  const [margensErro, setMargensErro] = useState(null)
  // Item 6: margens POR MUNICÍPIO da UF aberta — é o que pinta o calor e
  // alimenta o card de decisivos. Uma requisição por UF, com cache.
  const [margensUf, setMargensUf] = useState(null)
  const [margensUfCarregando, setMargensUfCarregando] = useState(false)
  const [margensUfErro, setMargensUfErro] = useState(null)
  const cacheMargensUfRef = useRef(new Map())

  useEffect(() => {
    if (!replayAberto || replays[fonte]) return undefined
    let ativo = true
    setReplayCarregando(true)
    setReplayErro(null)
    // Sem `modo`: a série de apuração de 2026, por passo. `modo=2022` é o
    // arquivo histórico do TSE (frames com relógio real).
    const url = fonte === '2022' ? `${API_BASE}/replay?modo=2022` : `${API_BASE}/replay`
    fetchJSON(url)
      .then((resposta) => {
        if (!ativo) return
        setReplayCarregando(false)
        if (!resposta?.disponivel) {
          setReplayErro(resposta?.nota || 'série indisponível')
          return
        }
        setReplays((anteriores) => ({ ...anteriores, [fonte]: resposta }))
      })
      .catch(() => {
        if (!ativo) return
        setReplayErro('não foi possível carregar a série do replay')
        setReplayCarregando(false)
      })
    return () => {
      ativo = false
    }
  }, [replayAberto, fonte, replays])

  // O agregado nacional de margens (`/api/margens`) é o dado mais lento da
  // tela: ele NÃO pode estar nas dependências, senão o cleanup cancela a
  // própria requisição (`ativo=false`) e o fetch nunca conclui — era o defeito
  // do "calculando margens…" eterno ao lado da lista já renderizada.
  useEffect(() => {
    if (!margensAberto || margens) return undefined
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
  }, [margensAberto, margens])

  // Item 6 — margens por município da UF aberta. Só busca com o modo MARGEM
  // ligado e uma UF selecionada (sem UF não há município para pintar).
  useEffect(() => {
    if (!margensAberto || !ufSelecionada) {
      setMargensUf(null)
      setMargensUfErro(null)
      setMargensUfCarregando(false)
      return undefined
    }

    const cache = cacheMargensUfRef.current
    if (cache.has(ufSelecionada)) {
      setMargensUf(cache.get(ufSelecionada))
      setMargensUfErro(null)
      setMargensUfCarregando(false)
      return undefined
    }

    let ativo = true
    setMargensUf(null)
    setMargensUfErro(null)
    setMargensUfCarregando(true)

    fetchJSON(`${API_BASE}/uf/${ufSelecionada}/margens`)
      .then((resposta) => {
        if (!ativo) return
        if (resposta?.erro) {
          setMargensUfErro(String(resposta.erro))
          setMargensUfCarregando(false)
          return
        }
        cache.set(ufSelecionada, resposta)
        setMargensUf(resposta)
        setMargensUfCarregando(false)
      })
      .catch(() => {
        if (!ativo) return
        setMargensUfErro('não foi possível carregar as margens desta UF')
        setMargensUfCarregando(false)
      })

    return () => {
      ativo = false
    }
  }, [margensAberto, ufSelecionada])

  // A série dos dois formatos vira uma lista só de passos (ver normalizarPassos).
  const passos = useMemo(() => normalizarPassos(replay), [replay])
  // Play: um passo a cada 700 ms em 1x, intervalo dividido pela velocidade
  // (8x, 60x). Para no último passo — que é o arquivo fechado, 100% apurado.
  useEffect(() => {
    if (!tocando) return undefined
    const total = passos.length
    if (total === 0) return undefined
    const intervalo = Math.max(INTERVALO_MIN_MS, INTERVALO_BASE_MS / velocidade)
    const relogio = setInterval(() => {
      setIndiceReplay((atual) => {
        if (atual >= total - 1) {
          setTocando(false)
          return total - 1
        }
        return atual + 1
      })
    }, intervalo)
    return () => clearInterval(relogio)
  }, [tocando, passos.length, velocidade])

  // Trocar de fonte troca o tamanho da série: o índice não pode passar do fim.
  useEffect(() => {
    if (passos.length === 0) return
    setIndiceReplay((atual) => (atual > passos.length - 1 ? passos.length - 1 : atual))
  }, [passos.length])

  // O que o mapa pinta (MapView lê `frame.ufs` e `base`): as seções apuradas
  // de cada UF no passo corrente e o total de seções por UF.
  const frameReplay = useMemo(() => {
    if (!replayAberto || passos.length === 0) return null
    const posicao = Math.min(Math.max(indiceReplay, 0), passos.length - 1)
    const passo = passos[posicao]
    return {
      frame: { i: passo.i, t: passo.t, pct_apurado: passo.pct, ufs: passo.uf },
      base: replay?.ufs_base || {},
    }
  }, [replayAberto, passos, indiceReplay, replay])

  // O passo do replay sobe para a página: cabeçalho do site e placar do painel
  // mostra o % e os VOTOS DO PASSO enquanto o replay corre. `null` com o
  // replay fechado devolve os dois ao valor oficial (arquivo 100%).
  const aoVivo = useMemo(() => {
    if (!replayAberto || passos.length === 0) return null
    const posicao = Math.min(Math.max(indiceReplay, 0), passos.length - 1)
    const passo = passos[posicao]
    if (!passo) return null
    return {
      pct: passo.pct,
      indice: posicao,
      total: passos.length,
      carimbo: passo.t
        ? relogioDoArquivo(passo.t)
        : `passo ${posicao + 1}/${passos.length}`,
      secoes: passo.secoes,
      candidatos: passo.placar,
    }
  }, [replayAberto, passos, indiceReplay])

  useEffect(() => {
    if (typeof onAoVivo === 'function') onAoVivo(aoVivo)
  }, [aoVivo, onAoVivo])

  // Ao desmontar (navegar para fora do mapa), o cabeçalho não pode continuar
  // em modo replay.
  useEffect(() => () => {
    if (typeof onAoVivo === 'function') onAoVivo(null)
  }, [onAoVivo])

  const trocarFonte = (nova) => {
    setTocando(false)
    setIndiceReplay(0)
    setFonte(nova)
  }

  const irAoFinal = () => {
    setTocando(false)
    setIndiceReplay(Math.max(passos.length - 1, 0))
  }

  const alternarReplay = () => {
    setReplayAberto((aberto) => {
      const novo = !aberto
      // Um modo por vez: ligar o replay desliga o calor de margem (o Pedro já
      // reclamou dos dois painéis ao mesmo tempo).
      if (novo) setMargensAberto(false)
      else setTocando(false)
      return novo
    })
  }

  // Item 6: UM comportamento no botão — liga/desliga o calor de margem. Ligar
  // desliga o replay; nada mais muda de significado com o botão.
  const alternarMargem = () => {
    const novo = !margensAberto
    setMargensAberto(novo)
    if (novo) {
      setReplayAberto(false)
      setTocando(false)
    }
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

  // Sem seleção não há o que detalhar: o painel fecha junto (o × da seleção e
  // o Escape continuam limpando UF/município/local, não só o painel).
  useEffect(() => {
    if (!selecionada) setDetalheAberto(false)
  }, [selecionada])

  // Um painel por vez no celular: ao selecionar estado/município/local, a
  // gaveta do placar fecha e sai de cena (a barra fina do topo já dá o
  // resumo nacional). Sem isso ela ficaria aberta e invisível, e o toque na
  // aba voltaria a empilhar dois painéis.
  useEffect(() => {
    if (selecionada) setGavetaAberta(false)
  }, [selecionada])

  const alvoLider = localDetalhe || municipioDetalhe || selecionada
  const linhaLider = alvoLider
    ? `${alvoLider.partido_lider || '—'} · ${alvoLider.lider || '—'} ${percentual(alvoLider.lider_pct)}`
    : '—'

  const aoPressionarAlca = (evento) => {
    detalheArrasteRef.current = { inicioY: evento.clientY, delta: 0 }
    evento.currentTarget.setPointerCapture?.(evento.pointerId)
  }

  const aoMoverAlca = (evento) => {
    if (!detalheArrasteRef.current) return
    detalheArrasteRef.current.delta = evento.clientY - detalheArrasteRef.current.inicioY
  }

  const aoSoltarAlca = (evento) => {
    const arraste = detalheArrasteRef.current
    if (!arraste) return
    detalheArrasteRef.current = null
    // Arrastar a alça para BAIXO fecha o painel; para cima ele já está aberto.
    if (arraste.delta > 24) setDetalheAberto(false)
    if (evento.currentTarget.hasPointerCapture?.(evento.pointerId)) {
      evento.currentTarget.releasePointerCapture(evento.pointerId)
    }
  }

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

  const mostrarAviso = celular && avisoVisivel
  const painelDetalheAberto = Boolean(selecionada) && detalheAberto

  return (
    <div
      className={`workspace${selecionada ? ' tem-selecao' : ''}${
        margensAberto ? ' margens-abertas' : ''
      }${painelDetalheAberto ? ' detalhe-aberto' : ''}${
        mostrarAviso ? ' com-aviso' : ''
      }`}
      style={{ '--sheet-detalhe-h': painelDetalheAberto ? `${alturaDetalhe}px` : '0px' }}
    >
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
          modoMargem={margensAberto}
          margensUf={margensUf}
        />
        <PlacarBarra estados={estados} aoVivo={aoVivo} />
        <div className="modos-mapa" role="group" aria-label="Modos de leitura do mapa">
          <button
            type="button"
            className={`modos-btn${replayAberto ? ' is-ativo' : ''}`}
            onClick={alternarReplay}
            aria-pressed={replayAberto}
            data-prova="modo-replay"
          >
            replay
          </button>
          <button
            type="button"
            className={`modos-btn${margensAberto ? ' is-ativo' : ''}`}
            onClick={alternarMargem}
            aria-pressed={margensAberto}
            data-prova="modo-margem"
          >
            margem
          </button>
        </div>
        {replayAberto ? (
          <ReplayBar
            replay={replay}
            passos={passos}
            indice={indiceReplay}
            tocando={tocando}
            velocidade={velocidade}
            fonte={fonte}
            carregando={replayCarregando}
            erro={replayErro}
            onIndice={(novo) => {
              setTocando(false)
              setIndiceReplay(novo)
            }}
            onPlayPause={() => setTocando((valor) => !valor)}
            onVelocidade={setVelocidade}
            onFonte={trocarFonte}
            onFinal={irAoFinal}
            onFechar={alternarReplay}
          />
        ) : null}
        <Legend zoom={zoom} modoMargem={margensAberto} />

        {/* Celular: o ÚNICO jeito de abrir o painel de detalhes. Fica no canto
            inferior direito, acima do safe-area, 56x56 — não cobre o canvas
            além da própria área e não intercepta gesto de zoom/arraste. */}
        {selecionada ? (
          <button
            type="button"
            className={`detalhe-toggle mobile-only${detalheAberto ? ' is-ativo' : ''}`}
            onClick={() => setDetalheAberto((valor) => !valor)}
            aria-label={detalheAberto ? 'Esconder detalhes' : 'Mostrar detalhes'}
            aria-expanded={detalheAberto}
            aria-controls="sheet-detalhe"
            data-prova="detalhe-toggle"
          >
            <span className="detalhe-toggle-sigla">{ufSelecionada}</span>
            <span className="detalhe-toggle-seta" aria-hidden="true">
              {detalheAberto ? '⌄' : '⌃'}
            </span>
          </button>
        ) : null}
      </main>

      {mostrarAviso ? <AvisoDesktop onDispensar={dispensarAviso} /> : null}

      <aside className="side-panel" ref={painelRef} aria-label="Painel da apuração">
        {margensAberto ? (
          <MargensCard
            margens={margens}
            carregando={margensCarregando}
            erro={margensErro}
            margensUf={margensUf}
            uf={ufSelecionada}
            carregandoUf={margensUfCarregando}
            erroUf={margensUfErro}
            onFechar={alternarMargem}
          />
        ) : null}

        <NationalScoreboard estados={estados} variante="panel" aoVivo={aoVivo} />

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
        aoVivo={aoVivo}
      />

      <section
        id="sheet-detalhe"
        ref={sheetDetalheRef}
        className={`bottom-sheet sheet-detalhe mobile-only${
          painelDetalheAberto ? ' is-open' : ''
        }`}
        aria-label="Detalhes da seleção no mapa"
        aria-hidden={!painelDetalheAberto}
        data-prova="sheet-detalhe"
      >
        <div
          className="sheet-grip"
          aria-hidden="true"
          onPointerDown={aoPressionarAlca}
          onPointerMove={aoMoverAlca}
          onPointerUp={aoSoltarAlca}
          onPointerCancel={aoSoltarAlca}
        />
        <div className="sheet-header">
          <button
            type="button"
            className="sheet-header-toque"
            onClick={() => setDetalheAberto((valor) => !valor)}
            aria-expanded={detalheAberto}
            aria-controls="sheet-detalhe-corpo"
          >
            <span className="sheet-header-texto">
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
              <span className="sheet-header-lider">{linhaLider}</span>
            </span>
            <span className="sheet-header-chevron" aria-hidden="true">
              ⌃
            </span>
          </button>
          <button
            type="button"
            className="sheet-close"
            onClick={fechar}
            aria-label="Fechar detalhes da seleção"
          >
            ×
          </button>
        </div>
        <div className="sheet-body" id="sheet-detalhe-corpo" ref={sheetBodyRef}>
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
              margensUf={margensUf}
              uf={ufSelecionada}
              carregandoUf={margensUfCarregando}
              erroUf={margensUfErro}
              onFechar={alternarMargem}
            />
          </div>
        ) : null}
      </section>
    </div>
  )
}
