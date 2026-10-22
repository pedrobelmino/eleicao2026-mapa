import { corDoPartido } from '../mapa.js'
import { numero, percentual, pontos } from '../format.js'

function Metric({ rotulo, valor, unidade, largura }) {
  return (
    <div className={`metric${largura ? ' metric--wide' : ''}`}>
      <dt>{rotulo}</dt>
      <dd>
        {valor}
        {unidade ? <span>{unidade}</span> : null}
      </dd>
    </div>
  )
}

export default function DetailCard({ uf, onClose, mostrarFechar = true }) {
  if (!uf) return null

  const cor = corDoPartido(uf.partido_lider)
  const candidatos = (uf.candidatos || []).slice(0, 2)

  return (
    <article
      className="detail-card"
      style={{ '--party-color': cor }}
      aria-label={`Detalhes de ${uf.nome}`}
    >
      <header className="detail-head">
        <div className="detail-head-copy">
          <div className="detail-kicker">
            <span className="detail-uf">{uf.uf}</span>
            <span className="detail-region">{uf.regiao}</span>
          </div>
          <h2 className="detail-title">{uf.nome}</h2>
        </div>
        {mostrarFechar ? (
          <button
            type="button"
            className="detail-close"
            onClick={onClose}
            aria-label="Fechar detalhes do estado"
          >
            ×
          </button>
        ) : null}
      </header>

      <div className="leader-banner">
        <span className="leader-flag">{uf.partido_lider || '—'}</span>
        <div className="leader-copy">
          <span>líder no estado</span>
          <strong>{uf.lider}</strong>
        </div>
        <span className="leader-pct">{percentual(uf.lider_pct)}</span>
      </div>

      <dl className="metrics">
        <Metric rotulo="% do líder" valor={percentual(uf.lider_pct)} />
        <Metric
          rotulo="Margem"
          valor={numero(uf.margem_votos)}
          unidade="votos"
        />
        <Metric
          rotulo="Margem"
          valor={pontos(uf.margem_pct)}
          unidade="pontos"
        />
        <Metric rotulo="Votos válidos" valor={numero(uf.vv)} largura />
      </dl>

      <section className="candidates">
        <h3>Dois primeiros</h3>
        <ol className="candidate-list">
          {candidatos.map((candidato, indice) => {
            const corCandidato = corDoPartido(candidato.partido)
            return (
              <li
                className="candidate"
                key={`${candidato.nome}-${candidato.partido}`}
                style={{ '--party-color': corCandidato }}
              >
                <span className="rank" aria-hidden="true">
                  {indice + 1}
                </span>
                <div className="candidate-identity">
                  <strong>{candidato.nome}</strong>
                  <span className="candidate-party">{candidato.partido}</span>
                </div>
                <div className="candidate-values">
                  <strong className="candidate-pct">
                    {percentual(candidato.pct)}
                  </strong>
                  <span className="candidate-votes">
                    {numero(candidato.votos)} votos
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      </section>
    </article>
  )
}
