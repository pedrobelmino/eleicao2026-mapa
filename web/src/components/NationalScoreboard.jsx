import { CORES_PARTIDO } from '../mapa.js'
import { numero, percentual } from '../format.js'

function acharCandidato(nacional, nome, partido) {
  const candidatos = nacional?.candidatos || []
  return (
    candidatos.find((c) => c.nome === nome) ||
    candidatos.find((c) => c.partido === partido) ||
    null
  )
}

function LinhaPlacar({ nome, partido, candidato }) {
  const cor = CORES_PARTIDO[partido]
  return (
    <div
      className="score-row"
      style={{ '--party-color': cor }}
      data-partido={partido}
    >
      <span className="score-party-bar" aria-hidden="true" />
      <div className="score-identity">
        <strong className="score-name">{nome}</strong>
        <span className="score-party">{partido}</span>
      </div>
      <div className="score-values">
        <strong className="score-pct">
          {candidato ? percentual(candidato.pct) : '—'}
        </strong>
        <span className="score-votes">
          {candidato ? `${numero(candidato.votos)} votos` : 'sem dados'}
        </span>
      </div>
    </div>
  )
}

export default function NationalScoreboard({ estados, variante = 'panel' }) {
  const nacional = estados?.nacional
  const flavio = acharCandidato(nacional, 'FLAVIO BOLSONARO', 'PL')
  const lula = acharCandidato(nacional, 'LULA', 'PT')

  return (
    <section
      className={`scoreboard scoreboard--${variante}`}
      aria-label="Placar nacional"
    >
      <div className="scoreboard-head">
        <span className="eyebrow">Placar nacional</span>
        <span className="scoreboard-turno">
          {nacional ? `${percentual(nacional.pct_apurado, 1)} apurado` : '—'}
        </span>
      </div>
      <div className="score-list">
        <LinhaPlacar
          nome="FLAVIO BOLSONARO"
          partido="PL"
          candidato={flavio}
        />
        <LinhaPlacar nome="LULA" partido="PT" candidato={lula} />
      </div>
    </section>
  )
}
