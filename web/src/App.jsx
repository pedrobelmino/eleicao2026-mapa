import Landing from './pages/Landing.jsx'
import Home from './pages/Home.jsx'
import Mapa from './pages/Mapa.jsx'
import { navega, useRota } from './router.jsx'

function NaoEncontrado() {
  return (
    <div className="home-app">
      <main className="nao-encontrado">
        <p className="codigo">404</p>
        <h1>página não encontrada</h1>
        <p>O endereço não existe neste site. Escolha uma das páginas abaixo.</p>
        <nav>
          <a
            href="/eleicao"
            onClick={(evento) => {
              evento.preventDefault()
              navega('/eleicao')
            }}
          >
            painel da apuração
          </a>
          <a
            href="/sobre"
            className="secundario"
            onClick={(evento) => {
              evento.preventDefault()
              navega('/sobre')
            }}
          >
            sobre Pedro Belmino
          </a>
          <a
            href="/mapa"
            className="secundario"
            onClick={(evento) => {
              evento.preventDefault()
              navega('/mapa')
            }}
          >
            abrir o mapa
          </a>
        </nav>
      </main>
    </div>
  )
}

// Quatro rotas, uma por nível:
//   /        painel da apuração — fallback para site servido sem nginx (ex.:
//            vite dev); no ar, a raiz pública redireciona para /eleicao
//   /eleicao painel da apuração em tempo real (a antiga home)
//   /sobre   landing "sobre mim"
//   /mapa    mapa interativo (preservado)
export default function App() {
  const rota = useRota()

  if (rota === '/') return <Home />
  if (rota === '/sobre') return <Landing />
  if (rota === '/eleicao') return <Home />
  if (rota === '/mapa') return <Mapa />
  return <NaoEncontrado />
}
