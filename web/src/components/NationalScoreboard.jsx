import { CORES_PARTIDO } from '../mapa.js'
import { numero, percentual } from '../format.js'
import { acharCandidato } from '../placar.js'
import Avatar from './Avatar.jsx'

function LinhaPlacar({ nome, partido, candidato }) {
  const cor = CORES_PARTIDO[partido]
  return (
    <div
      className="score-row"
      style={{ '--party-color': cor }}
      data-partido={partido}
    >
      <Avatar
        nome={nome}
        partido={partido}
        tamanho={34}
        className="score-avatar"
      />
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

// `aoVivo` (do replay) troca a fonte dos dois candidatos: com o replay tocando
// o painel mostra os votos DO PASSO — os mesmos que a barra do replay mostra —
// e o carimbo do passo. Sem replay (null) é o placar do arquivo fechado.
export default function NationalScoreboard({ estados, variante = 'panel', aoVivo = null }) {
  const nacional = aoVivo
    ? { ...estados?.nacional, pct_apurado: aoVivo.pct, candidatos: aoVivo.candidatos }
    : estados?.nacional
  const flavio = acharCandidato(nacional, 'FLAVIO BOLSONARO', 'PL')
  const lula = acharCandidato(nacional, 'LULA', 'PT')

  return (
    <section
      className={`scoreboard scoreboard--${variante}`}
      aria-label="Placar nacional"
      data-fonte={aoVivo ? 'replay' : 'oficial'}
      data-carimbo={aoVivo ? aoVivo.carimbo : null}
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
