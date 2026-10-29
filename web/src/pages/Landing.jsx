import { useEffect } from 'react'
import { navega } from '../router.jsx'
import { definirMeta } from '../meta.js'
import '../landing.css'

// Página /sobre — quem é o Pedro, sem o portfólio.
// 28/10/2026 (ADV-235): o portfólio saiu daqui e virou a rota /portfolio. O
// bloco "sobre mim" (selo, nome, linha de apresentação, menu de perfis e a
// linha de identidade do rodapé) volta inteiro — é o conteúdo que a ordem de
// ADV-218 tinha removido por engano.
// Rollback: Landing.jsx.bak-adv235-20261028-2205.
// Os quatro links externos abrem em aba nova (target=_blank + rel noopener).
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
        'Pedro Belmino, analista de sistemas. Desenvolvimento em Java, Go e IA. Perfis no LinkedIn, GitHub, Medium e no canal Belmino Souls. Portfólio de produtos em produção na página Portfólio.',
    })
  }, [])

  return (
    <div className="landing-app">
      <div className="landing-envelope">
        <nav className="landing-secoes" aria-label="seções do site">
          <a
            className="landing-secao"
            href="/sobre"
            aria-current="page"
            onClick={(evento) => {
              evento.preventDefault()
              navega('/sobre')
            }}
          >
            Quem sou eu
          </a>
          <a
            className="landing-secao"
            href="/portfolio"
            data-prova="nav-portfolio"
            onClick={(evento) => {
              evento.preventDefault()
              navega('/portfolio')
            }}
          >
            Portfólio <span aria-hidden="true">→</span>
          </a>
        </nav>

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

        <footer className="landing-rodape">
          <p>
            Fortaleza · Ceará — <b>Pedro Belmino</b>, analista de sistemas.
          </p>
          <p className="landing-rodape-fino">
            Site sem cookies, sem IP e sem rastreamento.
          </p>
        </footer>
      </div>
    </div>
  )
}
