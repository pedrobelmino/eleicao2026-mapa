import { useEffect, useState } from 'react'
import Header from '../components/Header.jsx'
import MapWorkspace from '../components/MapWorkspace.jsx'
import StateViews from '../components/StateViews.jsx'
import { API_BASE, fetchJSON } from '../api.js'
import Rodape from '../components/Rodape.jsx'
import { rotuloTurno } from '../format.js'
import { definirMeta } from '../meta.js'

const ESTADO_INICIAL = {
  fase: 'loading',
  estados: null,
  geojson: null,
  erro: null,
}

// A rota /mapa aceita atalhos de prova/drill-down: ?uf=CE&z=6.3, ?m=<cd_tse>
// (município já aberto), ?replay=<frame> (abre o replay naquele frame) e
// ?margem=1 (abre o mapa de calor de margem + o card). Sem query, tudo
// continua como antes (Brasil inteiro, sem UF selecionada).
function lerAtalhosDaUrl() {
  if (typeof window === 'undefined') {
    return { ufInicial: null, municipioInicial: null, zoomInicial: null, replayInicial: null, margemInicial: false }
  }
  const parametros = new URLSearchParams(window.location.search)
  const ufBruta = parametros.get('uf')
  const uf = ufBruta ? ufBruta.trim().toUpperCase() : ''
  const zoomBruto = parametros.get('z')
  const zoom = zoomBruto != null && zoomBruto.trim() !== '' ? Number(zoomBruto) : NaN
  const municipioBruto = parametros.get('m')
  const municipio = municipioBruto ? municipioBruto.trim() : ''
  const replayBruto = parametros.get('replay')
  const replay =
    replayBruto != null && /^\d+$/.test(replayBruto.trim())
      ? Number(replayBruto.trim())
      : null
  const margemBruta = parametros.get('margem')

  return {
    ufInicial: /^[A-Z]{2}$/.test(uf) ? uf : null,
    municipioInicial: /^\d+$/.test(municipio) ? municipio : null,
    zoomInicial: Number.isFinite(zoom) ? zoom : null,
    replayInicial: replay,
    margemInicial: margemBruta === '1' || margemBruta === 'true',
  }
}

// Workspace do mapa interativo. Só é montado na rota /mapa, então a home não
// dispara as buscas de /api/estados e /api/ufs.geojson.
export default function Mapa() {
  const [atalhos] = useState(lerAtalhosDaUrl)
  const [dados, setDados] = useState(ESTADO_INICIAL)
  const [tentativa, setTentativa] = useState(0)

  useEffect(() => {
    definirMeta({
      titulo: 'Mapa da apuração 2026 — estado, município e local de votação',
      descricao:
        'Mapa interativo da apuração presidencial de 2026: zoom do Brasil até o município e o local de votação, com os números oficiais do TSE.',
    })
  }, [])

  useEffect(() => {
    let ativo = true

    setDados(ESTADO_INICIAL)

    Promise.all([
      fetchJSON(`${API_BASE}/estados`),
      fetchJSON(`${API_BASE}/ufs.geojson`),
    ])
      .then(([estados, geojson]) => {
        if (!ativo) return
        setDados({ fase: 'ready', estados, geojson, erro: null })
      })
      .catch((erro) => {
        if (!ativo) return
        console.error('Falha ao carregar a apuração:', erro)
        setDados({ fase: 'error', estados: null, geojson: null, erro })
      })

    return () => {
      ativo = false
    }
  }, [tentativa])

  return (
    <div className="app">
      <Header estados={dados.estados} erro={dados.erro} />

      {dados.fase === 'loading' ? <StateViews tipo="loading" /> : null}

      {dados.fase === 'error' ? (
        <StateViews
          tipo="error"
          erro={dados.erro}
          onTentarNovamente={() => setTentativa((n) => n + 1)}
        />
      ) : null}

      {dados.fase === 'ready' ? (
        <MapWorkspace
          estados={dados.estados}
          geojson={dados.geojson}
          ufInicial={atalhos.ufInicial}
          municipioInicial={atalhos.municipioInicial}
          zoomInicial={atalhos.zoomInicial}
          replayInicial={atalhos.replayInicial}
          margemInicial={atalhos.margemInicial}
        />
      ) : null}

      <Rodape
        variante="mapa"
        eleicao={dados.estados?.eleicao}
        turno={dados.estados ? rotuloTurno(dados.estados.turno) : null}
        geradoEm={dados.estados?.gerado_em}
      />
    </div>
  )
}
