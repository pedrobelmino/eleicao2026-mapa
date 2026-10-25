import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE, fetchJSON } from '../api.js'
import { definirMeta } from '../meta.js'
import '../home.css'
import BannerAtualizacao from '../components/BannerAtualizacao.jsx'
import {
  INTERVALO_APURANDO_MS,
  INTERVALO_PARADO_MS,
  estadoDaApuracao,
  useAtualizacaoAutomatica,
} from '../atualizacao.js'
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
import AguardandoTSE from '../components/AguardandoTSE.jsx'

export default function Home() {
  const [estado, setEstado] = useState({ fase: 'loading', dados: null })
  const [tentativa, setTentativa] = useState(0)

  const dados = estado.dados

  // O retrato em disco pode ser de OUTRO turno (a virada troca ELEICAO/TURNO
  // no ambiente antes de o TSE publicar o arquivo novo). Nesse estado a API
  // responde `incoerente: true` e payload zerado: a tela troca os cards pelo
  // estado de espera em vez de mostrar 100% de uma apuração que já passou.
  const incoerente = Boolean(dados?.incoerente || dados?.sem_dado)

  // Banner: fase vem do DADO na tela (não do relógio). Sem dado não há fase
  // afirmada: o banner mostra o TEXTO_ESPERA fixo (sem ordinal de turno) e
  // troca sozinho quando o voto novo chega.
  const apuracao = estadoDaApuracao({
    pct: dados?.nacional?.pct_apurado,
    turno: dados?.dados_turno ?? dados?.turno,
    semDado: Boolean(dados?.sem_dado),
    incoerente: Boolean(dados?.incoerente),
  })
  // 60 s com a apuração parada, 30 s enquanto os votos estão chegando.
  const intervaloDeCarga =
    apuracao.fase === 'andamento' ? INTERVALO_APURANDO_MS : INTERVALO_PARADO_MS

  // Nível 2 tem título e descrição próprios (a raiz é a landing).
  useEffect(() => {
    definirMeta({
      titulo: 'Eleição 2026 — Presidente · apuração em tempo real',
      descricao:
        'Apuração da eleição presidencial de 2026 em tempo real, direto dos dados oficiais do TSE: placar nacional, por região, por estado e linha do tempo.',
    })
  }, [])

  // UMA função de carga, usada pela montagem E pelo ciclo automático. O
  // caminho de atualização nunca passa por `setEstado({ fase: 'loading' })`:
  // o dado novo entra por cima do velho e a tela não pisca.
  const carregar = useCallback(async () => {
    try {
      const resposta = await fetchJSON(`${API_BASE}/home`)
      // O ciclo NÃO pode esvaziar o painel: 200 sem `publico` é falha, não
      // "dado vazio" (senão um defeito do coletor viraria tela em branco).
      if (!resposta?.publico) throw new Error('resposta sem dados')
      setEstado({ fase: 'ready', dados: resposta.publico })
      return true
    } catch {
      setEstado((atual) => (atual.dados ? atual : { fase: 'error', dados: null }))
      return false
    }
  }, [])

  const atualizacao = useAtualizacaoAutomatica({
    aoCiclar: carregar,
    intervaloMs: intervaloDeCarga,
  })
  // A montagem precisa das funções de registro estáveis do hook; guardar o
  // objeto inteiro no ref evita reassinar o ciclo a cada render.
  const registrarLeituraRef = useRef(atualizacao.registrarLeitura)
  const registrarFalhaRef = useRef(atualizacao.registrarFalha)
  registrarLeituraRef.current = atualizacao.registrarLeitura
  registrarFalhaRef.current = atualizacao.registrarFalha

  useEffect(() => {
    let ativo = true
    carregar().then((ok) => {
      if (!ativo) return
      if (ok) registrarLeituraRef.current()
      else registrarFalhaRef.current()
    })
    return () => {
      ativo = false
    }
  }, [carregar, tentativa])

  const temMapa =
    Boolean(dados) &&
    !dados.sem_dado &&
    Object.keys(dados.mapa?.ufs || {}).length > 0

  return (
    <div className="home-app">
      <BannerAtualizacao
        fase={apuracao.fase}
        pct={apuracao.pct}
        ultimaLeitura={atualizacao.ultimaLeitura}
        falha={atualizacao.falha}
        pausada={atualizacao.pausada}
      />
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
          incoerente ? (
            <main>
              <div className="pilha">
                <AguardandoTSE
                  eleicao={dados.eleicao}
                  turno={dados.turno}
                  variante="home"
                />
              </div>
            </main>
          ) : (
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
          )
        ) : (
          <div className="pilha">
            <div className="card">
              <div className="carregando">
                Coletando os números do TSE…
                <br />
                <span className="vazio">
                  os dados se atualizam sozinhos, sem recarregar a página.
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
          <Rodape
            variante="home"
            eleicao={dados?.eleicao}
            turno={dados?.turno}
            geradoEm={incoerente ? null : dados?.gerado_em}
            mostrarCanal={false}
          />
        </div>
      </div>
    </div>
  )
}
