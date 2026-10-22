import { useEffect, useState } from 'react'
import Header from '../components/Header.jsx'
import MapWorkspace from '../components/MapWorkspace.jsx'
import StateViews from '../components/StateViews.jsx'
import { API_BASE, fetchJSON } from '../api.js'

const ESTADO_INICIAL = {
  fase: 'loading',
  estados: null,
  geojson: null,
  erro: null,
}

// A rota /mapa aceita atalhos de prova/drill-down: ?uf=CE&z=6.3. Sem query,
// tudo continua como antes (Brasil inteiro, sem UF selecionada).
function lerAtalhosDaUrl() {
  if (typeof window === 'undefined') {
    return { ufInicial: null, zoomInicial: null }
  }
  const parametros = new URLSearchParams(window.location.search)
  const ufBruta = parametros.get('uf')
  const uf = ufBruta ? ufBruta.trim().toUpperCase() : ''
  const zoomBruto = parametros.get('z')
  const zoom = zoomBruto != null && zoomBruto.trim() !== '' ? Number(zoomBruto) : NaN

  return {
    ufInicial: /^[A-Z]{2}$/.test(uf) ? uf : null,
    zoomInicial: Number.isFinite(zoom) ? zoom : null,
  }
}

// Workspace do mapa interativo. Só é montado na rota /mapa, então a home não
// dispara as buscas de /api/estados e /api/ufs.geojson.
export default function Mapa() {
  const [atalhos] = useState(lerAtalhosDaUrl)
  const [dados, setDados] = useState(ESTADO_INICIAL)
  const [tentativa, setTentativa] = useState(0)

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
          zoomInicial={atalhos.zoomInicial}
        />
      ) : null}
    </div>
  )
}
