import { corDoPartido } from '../mapa.js'
import { numero, percentual, pontos } from '../format.js'
import Avatar from './Avatar.jsx'

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

export default function MunicipioCard({ municipio, uf, onVoltar }) {
  if (!municipio) return null

  const cor = corDoPartido(municipio.partido_lider)

  return (
    <article
      className="detail-card mun-card"
      style={{ '--party-color': cor }}
      aria-label={`Detalhes de ${municipio.nome}`}
    >
      <header className="detail-head">
        <div className="detail-head-copy">
          <div className="detail-kicker">
            <span className="detail-uf">{uf || '—'}</span>
            <span className="detail-region">município</span>
          </div>
          <h2 className="detail-title">{municipio.nome}</h2>
        </div>
        <button type="button" className="mun-voltar" onClick={onVoltar}>
          ← voltar ao estado
        </button>
      </header>

      <div className="leader-banner">
        <Avatar
          nome={municipio.lider}
          partido={municipio.partido_lider}
          tamanho={36}
          className="leader-avatar"
        />
        <span className="leader-flag">{municipio.partido_lider || '—'}</span>
        <div className="leader-copy">
          <span>líder no município</span>
          <strong>{municipio.lider || '—'}</strong>
        </div>
        <span className="leader-pct">{percentual(municipio.lider_pct)}</span>
      </div>

      <dl className="metrics">
        <Metric rotulo="% do líder" valor={percentual(municipio.lider_pct)} />
        <Metric
          rotulo="Margem"
          valor={numero(municipio.margem_votos)}
          unidade="votos"
        />
        <Metric
          rotulo="Margem"
          valor={pontos(municipio.margem_pct)}
          unidade="pontos"
        />
        <Metric
          rotulo="Votos válidos"
          valor={numero(municipio.vv)}
          largura
        />
      </dl>

      <section className="candidates mun-totais">
        <h3>Participação</h3>
        <ol className="candidate-list">
          <li className="candidate" style={{ '--party-color': 'var(--muted)' }}>
            <span className="rank" aria-hidden="true">
              1
            </span>
            <div className="candidate-identity">
              <strong>Total de votos</strong>
              <span className="candidate-votes">comparecimento</span>
            </div>
            <div className="candidate-values">
              <strong className="candidate-pct">{numero(municipio.total)}</strong>
              <span className="candidate-votes">votos</span>
            </div>
          </li>
          <li className="candidate" style={{ '--party-color': 'var(--muted)' }}>
            <span className="rank" aria-hidden="true">
              2
            </span>
            <div className="candidate-identity">
              <strong>Seções eleitorais</strong>
              <span className="candidate-votes">urnas no município</span>
            </div>
            <div className="candidate-values">
              <strong className="candidate-pct">
                {numero(municipio.secoes)}
              </strong>
              <span className="candidate-votes">seções</span>
            </div>
          </li>
        </ol>
      </section>
    </article>
  )
}
