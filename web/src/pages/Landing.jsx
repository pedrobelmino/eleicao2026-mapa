import { useEffect } from 'react'
import { navega } from '../router.jsx'
import { definirMeta } from '../meta.js'
import '../landing.css'

// Página /sobre: só o portfólio.
// Ordem de 28/10/2026 (ADV-218): o bloco "sobre mim" (selo, nome, linha de
// apresentação e o menu de perfis LinkedIn/GitHub/Medium/YouTube) saiu daqui.
// O que sobra é o produto, e o rodapé neutro do site — nada de apresentação
// pessoal na página. Rollback: Landing.jsx.bak-antes-remover-sobre-20261028.

export default function Landing() {
  useEffect(() => {
    definirMeta({
      titulo: 'Portfólio — Pedro Belmino',
      descricao:
        'Portfólio de Pedro Belmino: monitoramento da eleição presidencial 2026, com placar da apuração em tempo real e mapa interativo da votação.',
    })
  }, [])

  // O SPA é client-rendered: no acesso direto a /sobre#portfolio o navegador
  // procura a âncora antes de o React montar a seção, então não rola sozinho.
  // Aqui a rolagem é feita depois do primeiro render.
  useEffect(() => {
    const alvo = window.location.hash.replace(/^#/, '')
    if (!alvo) return undefined
    const quadro = window.requestAnimationFrame(() => {
      document.getElementById(alvo)?.scrollIntoView({ block: 'start' })
    })
    return () => window.cancelAnimationFrame(quadro)
  }, [])

  return (
    <div className="landing-app">
      <div className="landing-envelope">
        <section
          id="portfolio"
          className="landing-portfolio"
          aria-labelledby="landing-portfolio-titulo"
        >
          <h1 id="landing-portfolio-titulo">Portfólio</h1>

          <article className="landing-eleicao">
            <div className="landing-eleicao-texto">
              <span className="landing-etiqueta">produto em produção</span>
              <h2>Eleição 2026 — acompanhamento e mapa</h2>
              <p>
                Painel da apuração presidencial que lê os dados oficiais do TSE
                e se atualiza sozinho: placar, regiões, estados e o mapa
                interativo com drill-down até o local de votação.
              </p>
            </div>
            <div className="landing-eleicao-acoes">
              <button
                type="button"
                className="landing-cta"
                onClick={() => navega('/eleicao')}
              >
                Acompanhar a apuração
                <span aria-hidden="true">→</span>
              </button>
              <button
                type="button"
                className="landing-cta landing-cta--secundario"
                onClick={() => navega('/mapa')}
              >
                Abrir o mapa interativo
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </article>
        </section>

        <footer className="landing-rodape">
          <p className="landing-rodape-fino">
            Painel eleitoral sem cookies, sem IP e sem rastreamento: a contagem
            de visitas é anônima.
          </p>
        </footer>
      </div>
    </div>
  )
}
