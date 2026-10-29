import { useEffect } from 'react'
import { navega } from '../router.jsx'
import { definirMeta } from '../meta.js'
import '../landing.css'

// Página /portfolio — os produtos em produção.
// 28/10/2026 (ADV-235): o bloco saiu de dentro da /sobre e ganhou rota própria,
// com o mesmo conteúdo (card 'Eleição 2026' + os dois CTAs). O link legado
// /sobre#portfolio é encaminhado para cá pelo router (encaminharLinkLegado).
// Rollback: Portfolio.jsx.bak-adv235-20261028-2205.
export default function Portfolio() {
  useEffect(() => {
    definirMeta({
      titulo: 'Portfólio — Pedro Belmino',
      descricao:
        'Portfólio de Pedro Belmino: monitoramento da eleição presidencial 2026, com placar da apuração em tempo real e mapa interativo da votação.',
    })
  }, [])

  return (
    <div className="landing-app">
      <div className="landing-envelope">
        <nav className="landing-secoes" aria-label="seções do site">
          <a
            className="landing-secao"
            href="/sobre"
            data-prova="nav-sobre"
            onClick={(evento) => {
              evento.preventDefault()
              navega('/sobre')
            }}
          >
            <span aria-hidden="true">←</span> Quem sou eu
          </a>
          <a
            className="landing-secao"
            href="/portfolio"
            aria-current="page"
            onClick={(evento) => {
              evento.preventDefault()
              navega('/portfolio')
            }}
          >
            Portfólio
          </a>
        </nav>

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
