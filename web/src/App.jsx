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
            href="/"
            onClick={(evento) => {
              evento.preventDefault()
              navega('/')
            }}
          >
            ir para a página inicial
          </a>
          <a
            href="/eleicao"
            className="secundario"
            onClick={(evento) => {
              evento.preventDefault()
              navega('/eleicao')
            }}
          >
            painel da eleição
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

// Três níveis, um nível por rota:
//   /        landing "sobre mim" (porta de entrada)
//   /eleicao painel da apuração em tempo real (a antiga home)
//   /mapa    mapa interativo (preservado)
export default function App() {
  const rota = useRota()

  if (rota === '/') return <Landing />
  if (rota === '/eleicao') return <Home />
  if (rota === '/mapa') return <Mapa />
  return <NaoEncontrado />
}
