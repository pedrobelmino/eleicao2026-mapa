// Barra fina do topo (só no celular): o placar nacional inteiro em duas linhas
// de 10,5 px, ~46 px de altura. Formato de cada linha:
//
//   PL FLAVIO BOLSONARO 47,03% 56.104.503
//   PT LULA             45,16% 53.879.538
//
// As quatro colunas são do GRID da barra, não de cada linha: assim o partido, o
// nome, o percentual e os votos ficam alinhados entre as duas linhas mesmo com
// nomes de tamanhos diferentes.
import { CORES_PARTIDO } from '../mapa.js'
import { numero, percentual } from '../format.js'
import { NOMES, dueloNacional } from '../placar.js'

function Linha({ partido, nome, candidato }) {
  return (
    <span
      className="placar-barra-linha"
      style={{ '--party-color': CORES_PARTIDO[partido] }}
      data-partido={partido}
    >
      <b className="pb-partido">{partido}</b>
      <span className="pb-nome">{nome}</span>
      <span className="pb-pct">{candidato ? percentual(candidato.pct) : '—'}</span>
      <span className="pb-votos">
        {candidato ? numero(candidato.votos) : 'sem dados'}
      </span>
    </span>
  )
}

export default function PlacarBarra({ estados }) {
  const duelo = dueloNacional(estados?.nacional)

  return (
    <div
      className="placar-barra"
      role="group"
      aria-label="Placar nacional: partido, candidato, percentual e votos"
    >
      <Linha
        partido={NOMES.flavio.partido}
        nome={NOMES.flavio.nome}
        candidato={duelo.flavio}
      />
      <Linha
        partido={NOMES.lula.partido}
        nome={NOMES.lula.nome}
        candidato={duelo.lula}
      />
    </div>
  )
}
