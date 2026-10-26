import { useEffect, useRef, useState } from 'react'
import { API_BASE, fetchJSON } from '../../api.js'
import GraficoSerie from './GraficoSerie.jsx'

// Linha do tempo com duas camadas: a série de 2026 (vem em /api/home) e a
// referência de 2022 (buscada só quando a camada é aberta).
export default function LinhaTempo({ dados }) {
  const [camada, setCamada] = useState('2026')
  const [serie2022, setSerie2022] = useState(null)
  const [erro2022, setErro2022] = useState(false)
  const [carregando2022, setCarregando2022] = useState(false)
  const buscando = useRef(false)

  useEffect(() => {
    if (
      camada !== '2022' ||
      serie2022 !== null ||
      erro2022 ||
      buscando.current
    ) {
      return
    }

    buscando.current = true
    setCarregando2022(true)

    fetchJSON(`${API_BASE}/serie2022`)
      .then((resposta) => setSerie2022(resposta?.pontos || []))
      .catch(() => setErro2022(true))
      .finally(() => {
        buscando.current = false
        setCarregando2022(false)
      })
  }, [camada, serie2022, erro2022])

  const nacional = dados.nacional || {}
  const nomes = (nacional.candidatos || [])
    .slice(0, 2)
    .map((candidato) => candidato.nome)
    .filter(Boolean)

  return (
    <>
      <div
        className="camadas"
        role="group"
        aria-label="Camada da linha do tempo"
      >
        <button
          type="button"
          className={`camada${camada === '2026' ? ' ativa' : ''}`}
          aria-pressed={camada === '2026'}
          onClick={() => setCamada('2026')}
        >
          2026 (ao vivo, série do painel)
        </button>
        <button
          type="button"
          className={`camada${camada === '2022' ? ' ativa' : ''}`}
          aria-pressed={camada === '2022'}
          onClick={() => setCamada('2022')}
        >
          2022 (referência TSE)
        </button>
      </div>

      <div className="serie-palco">
        {camada === '2026' ? (
          <GraficoSerie
            pontos={dados.serie || []}
            rotulo="2026"
            nomesPreferidos={nomes}
            candidatos={nacional.candidatos || []}
            fonte={dados.fonte_gerada_texto}
          />
        ) : null}

        {camada === '2022' && erro2022 ? (
          <p className="vazio">
            não foi possível carregar a série de 2022 agora.
          </p>
        ) : null}

        {camada === '2022' && !erro2022 && carregando2022 ? (
          <p className="vazio">carregando a série histórica de 2022…</p>
        ) : null}

        {camada === '2022' && !erro2022 && serie2022 !== null ? (
          <GraficoSerie pontos={serie2022} rotulo="2022" />
        ) : null}
      </div>
    </>
  )
}
