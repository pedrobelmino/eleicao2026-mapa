import { useEffect, useState } from 'react'
import { API_BASE, fetchJSON } from '../api.js'
import '../home.css'
import Selos from '../components/home/Selos.jsx'
import CabecalhoApuracao from '../components/home/CabecalhoApuracao.jsx'
import Placar from '../components/home/Placar.jsx'
import Regioes from '../components/home/Regioes.jsx'
import Fenomeno from '../components/home/Fenomeno.jsx'
import MapaMomento from '../components/home/MapaMomento.jsx'
import Insights from '../components/home/Insights.jsx'
import Estados from '../components/home/Estados.jsx'
import Fontes from '../components/home/Fontes.jsx'
import LinhaTempo from '../components/home/LinhaTempo.jsx'
import Rodape from '../components/Rodape.jsx'

const CANAL_YOUTUBE = 'https://www.youtube.com/@belmino.c.f'

export default function Home() {
  const [estado, setEstado] = useState({ fase: 'loading', dados: null })
  const [tentativa, setTentativa] = useState(0)

  useEffect(() => {
    let ativo = true
    setEstado({ fase: 'loading', dados: null })

    fetchJSON(`${API_BASE}/home`)
      .then((resposta) => {
        if (!ativo) return
        setEstado({ fase: 'ready', dados: resposta?.publico || null })
      })
      .catch(() => {
        if (!ativo) return
        setEstado({ fase: 'error', dados: null })
      })

    return () => {
      ativo = false
    }
  }, [tentativa])

  const dados = estado.dados
  const temMapa =
    Boolean(dados) &&
    !dados.sem_dado &&
    Object.keys(dados.mapa?.ufs || {}).length > 0

  return (
    <div className="home-app">
      <div className="envelope">
        <header className="topo">
          <span className="selo">
            <i />
            dados oficiais do TSE
          </span>
          <h1>
            Eleição 2026 <span>· Presidente</span>
          </h1>
          <p className="sub">
            Apuração por estado e por região, sem chute: só o que o Tribunal
            Superior Eleitoral publica. Atualiza sozinho <span>agora</span>.
          </p>
        </header>

        {dados ? (
          <main>
            <div className="pilha">
              <CabecalhoApuracao dados={dados} />

              <div className="card">
                <h2>
                  Placar <Selos tipos={['TSE']} />
                </h2>
                <div className="placar">
                  <Placar dados={dados} />
                </div>
              </div>

              <div className="card">
                <h2>
                  Por região <Selos tipos={['TSE', 'CONTA']} />
                </h2>
                <Regioes dados={dados} />
              </div>

              <div className="card">
                <h2>
                  Painel do fenômeno{' '}
                  <Selos tipos={['TSE', 'CONTA', 'ESTIMATIVA']} />
                </h2>
                <Fenomeno dados={dados} />
              </div>

              {temMapa ? (
                <div className="card">
                  <h2>
                    Mapa do momento <Selos tipos={['TSE']} />
                  </h2>
                  <MapaMomento dados={dados} />
                </div>
              ) : null}

              <div className="card">
                <h2>
                  O que os números dizem{' '}
                  <Selos tipos={['TSE', 'CONTA', 'ESTIMATIVA']} />
                </h2>
                <Insights dados={dados} />
              </div>

              <div className="card">
                <h2>
                  Por estado <Selos tipos={['TSE']} />
                </h2>
                <Estados dados={dados} />
              </div>

              <div className="card">
                <h2>
                  Fontes por estado <Selos tipos={['TSE']} />
                </h2>
                <Fontes dados={dados} />
              </div>

              <div className="card">
                <h2>
                  Linha do tempo <Selos tipos={['TSE', 'CONTA']} />
                </h2>
                <LinhaTempo dados={dados} />
              </div>
            </div>
          </main>
        ) : (
          <div className="pilha">
            <div className="card">
              <div className="carregando">
                Coletando os números do TSE…
                <br />
                <span className="vazio">
                  a página recarrega sozinha em instantes.
                </span>
              </div>
              {estado.fase === 'error' ? (
                <div style={{ textAlign: 'center' }}>
                  <button
                    type="button"
                    className="tentar-de-novo"
                    onClick={() => setTentativa((n) => n + 1)}
                  >
                    tentar de novo
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}

        <div className="pilha">
          <div className="cta">
            <p>
              <b>Gostou do painel?</b> Ele é atualizado direto da fonte oficial
              e eu explico os bastidores no canal.
            </p>
            <a
              href={CANAL_YOUTUBE}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Se inscreve no meu canal do YouTube (abre em nova aba)"
            >
              Se inscreve no meu canal →
            </a>
          </div>

          <Rodape
            variante="home"
            eleicao={dados?.eleicao}
            turno={dados?.turno}
            geradoEm={dados?.gerado_em}
          />
        </div>
      </div>
    </div>
  )
}
