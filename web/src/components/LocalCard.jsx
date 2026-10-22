import { corDoPartido } from '../mapa.js'
import { numero, percentual, pontos } from '../format.js'

function temNumero(valor) {
  const n = Number(valor)
  return Number.isFinite(n)
}

// Detalhe do LOCAL DE VOTAÇÃO (nível urna). A agregação por nr_local vem do
// backend (/api/uf/{UF}/locais?cd=); aqui só se apresenta o local e as suas
// seções, uma a uma — cada seção é uma urna.
export default function LocalCard({ local, uf, municipio, totalLocais, onVoltar }) {
  if (!local) return null

  const cor = corDoPartido(local.partido_lider)
  const secoes = Array.isArray(local.secoes) ? local.secoes : []
  const nrLocais = Array.isArray(local.nr_locais) ? local.nr_locais : []
  const pctApurado = Number(local.pct_apurado)
  const temPctApurado = Number.isFinite(pctApurado)
  const pctLimitado = temPctApurado
    ? Math.min(Math.max(pctApurado, 0), 100)
    : 0

  return (
    <article
      className="detail-card local-card"
      style={{ '--party-color': cor }}
      aria-label={`Detalhes do local de votação ${local.nr_local}`}
    >
      <header className="detail-head">
        <div className="detail-head-copy">
          <div className="detail-kicker">
            <span className="detail-uf">{uf || '—'}</span>
            <span className="detail-region">local de votação</span>
          </div>
          <h2 className="detail-title">Local {local.nr_local ?? '—'}</h2>
          {municipio ? <p className="local-municipio">{municipio}</p> : null}
        </div>
        <button type="button" className="mun-voltar" onClick={onVoltar}>
          ← voltar ao município
        </button>
      </header>

      {local.agrupado ? (
        <p className="local-grupo">
          grupo de {nrLocais.length || '—'} locais:{' '}
          {nrLocais.length ? nrLocais.join(', ') : local.nr_local ?? '—'}
        </p>
      ) : null}

      <div className="leader-banner">
        <span className="leader-flag">{local.partido_lider || '—'}</span>
        <div className="leader-copy">
          <span>presidente favorável no local</span>
          <strong>{local.lider || '—'}</strong>
          <span className="leader-margem">
            margem {numero(local.margem_votos)} votos ·{' '}
            {pontos(local.margem_pct)} pts
          </span>
        </div>
        <span className="leader-pct">{percentual(local.lider_pct)}</span>
      </div>

      <section className="local-apurado" aria-label="Percentual apurado do local">
        <div className="local-apurado-top">
          <span className="local-apurado-label">% apurado</span>
          <strong className="local-apurado-numero">
            {temPctApurado ? percentual(pctApurado, 1) : '—'}
          </strong>
        </div>
        <div
          className="local-apurado-bar"
          role="img"
          aria-label={`${temPctApurado ? percentual(pctApurado, 1) : '—'} apurado`}
        >
          <span style={{ width: `${pctLimitado}%` }} />
        </div>
        <p className="local-apurado-secoes">
          {temPctApurado ? `${percentual(pctApurado, 1)} apurado` : '—'}
          {' · '}
          {numero(local.secoes_apuradas)} de{' '}
          {numero(local.secoes_esperadas)} seções
        </p>
      </section>

      <dl className="metrics">
        <Metric rotulo="Votos no local" valor={numero(local.total)} unidade="votos" />
        <Metric rotulo="Votos válidos" valor={numero(local.vv)} unidade="votos" />
        <Metric
          rotulo="Margem"
          valor={numero(local.margem_votos)}
          unidade="votos"
        />
        <Metric
          rotulo="Margem"
          valor={pontos(local.margem_pct)}
          unidade="pontos"
        />
      </dl>

      <section className="candidates local-secoes">
        <h3>
          seções (urnas) do local — {secoes.length}
          {totalLocais ? (
            <span className="local-total">
              {' '}
              · {numero(totalLocais)} locais no município
            </span>
          ) : null}
        </h3>
        <ol className="candidate-list section-list">
          {secoes.map((secao, indice) => (
            <li
              key={`${secao.zona}-${secao.secao}-${indice}`}
              className="candidate section-item"
            >
              <span className="rank">
                zona {temNumero(secao.zona) ? secao.zona : '—'}
              </span>
              <div className="candidate-identity">
                <strong>
                  seção {temNumero(secao.secao) ? secao.secao : '—'}
                </strong>
                <span className="candidate-votes">
                  líder: {secao.lider || '—'}
                </span>
              </div>
              <div className="candidate-values">
                <strong className="candidate-pct">{numero(secao.total)}</strong>
                <span className="candidate-votes">
                  votos ·{' '}
                  {temNumero(secao.pct_apurado)
                    ? `${percentual(secao.pct_apurado, 1)} apurado`
                    : '—'}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </article>
  )
}

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
