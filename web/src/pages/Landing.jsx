import { useEffect } from 'react'
import { navega } from '../router.jsx'
import { definirMeta } from '../meta.js'
import '../landing.css'

// Nível 1 das rotas: quem é o Pedro, para onde ir a partir daqui.
// Os quatro links externos abrem em aba nova (target=_blank + rel noopener).
// O Medium ainda NÃO tem URL confirmada — o item fica visível, mas travado.
const LINKS = [
  {
    chave: 'linkedin',
    titulo: 'LinkedIn',
    descricao: 'trajetória, experiências e contato profissional',
    href: 'https://www.linkedin.com/in/pedrobelmino',
    rotulo: 'in/pedrobelmino',
  },
  {
    chave: 'github',
    titulo: 'GitHub',
    descricao: 'código, projetos e experimentos abertos',
    href: 'https://github.com/pedrobelmino',
    rotulo: 'github.com/pedrobelmino',
  },
  {
    chave: 'medium',
    titulo: 'Medium',
    descricao: 'textos sobre engenharia e arquitetura',
    href: 'https://medium.com/@pedrobelmino',
    rotulo: '@pedrobelmino',
  },
  {
    chave: 'youtube',
    titulo: 'YouTube · Belmino Souls',
    descricao: 'canal de games: Dark Souls, Elden Ring e outros soulslike',
    href: 'https://www.youtube.com/@belmino.c.f',
    rotulo: '@belmino.c.f',
  },
]

export default function Landing() {
  useEffect(() => {
    definirMeta({
      titulo: 'Pedro Belmino — Analista de Sistemas',
      descricao:
        'Pedro Belmino, analista de sistemas. Desenvolvimento em Java, Go e IA. Perfis no LinkedIn, GitHub, Medium e no canal Belmino Souls. Portfólio com o monitoramento da eleição 2026 e o mapa interativo.',
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
        <header className="landing-topo">
          <span className="landing-selo">
            <i aria-hidden="true" />
            analista de sistemas
          </span>
          <h1>Pedro Belmino</h1>
          <p className="landing-linha">
            Construo sistemas em <b>Java</b> e <b>Go</b> e ponho <b>IA</b> para
            trabalhar dentro deles — arquitetura de soluções, APIs e automação
            de verdade, com teste antes de confiar.
          </p>
        </header>

        <nav className="landing-portas" aria-label="perfis e canais">
          {LINKS.map((item) => (
            <a
              key={item.chave}
              className={`landing-porta landing-porta--${item.chave}${
                item.pendente ? ' landing-porta--pendente' : ''
              }`}
              href={item.href}
              {...(item.pendente
                ? { 'aria-disabled': 'true', title: 'link ainda não confirmado' }
                : { target: '_blank', rel: 'noopener noreferrer' })}
            >
              <span className="landing-porta-nome">{item.titulo}</span>
              <span className="landing-porta-desc">{item.descricao}</span>
              <span className="landing-porta-url">{item.rotulo} ↗</span>
            </a>
          ))}
        </nav>

        <section
          id="portfolio"
          className="landing-portfolio"
          aria-labelledby="landing-portfolio-titulo"
        >
          <h2 id="landing-portfolio-titulo">Portfólio</h2>

          <article className="landing-eleicao">
            <div className="landing-eleicao-texto">
              <span className="landing-etiqueta">produto em produção</span>
              <h3>Eleição 2026 — acompanhamento e mapa</h3>
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
          <p>
            Fortaleza · Ceará — <b>Pedro Belmino</b>, analista de sistemas.
          </p>
          <p className="landing-rodape-fino">
            Painel eleitoral sem cookies, sem IP e sem rastreamento: a contagem
            de visitas é anônima.
          </p>
        </footer>
      </div>
    </div>
  )
}
