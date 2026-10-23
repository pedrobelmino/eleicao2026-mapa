// Gaveta do placar (só no celular): o painel do desktop cabe numa bottom-sheet.
//
// Fechada fica no estado `is-peek` — ~70 px com kicker, título, linha do líder e
// o chevron de 44 px (alvo de toque). Aberta (`is-open`) mostra o placar do
// painel + as quatro métricas que o desktop tem na lateral: margem, válidos,
// participação e seções apuradas.
import NationalScoreboard from './NationalScoreboard.jsx'
import { numero, percentual, pontos } from '../format.js'
import { dueloNacional } from '../placar.js'

function Metrica({ rotulo, valor, detalhe }) {
  return (
    <li className="gaveta-metrica">
      <span className="gaveta-metrica-rotulo">{rotulo}</span>
      <strong className="gaveta-metrica-valor">{valor}</strong>
      {detalhe ? <span className="gaveta-metrica-detalhe">{detalhe}</span> : null}
    </li>
  )
}

export default function PlacarGaveta({ estados, aberta = false, onToggle }) {
  const duelo = dueloNacional(estados?.nacional)
  const lider = duelo.lider

  return (
    <section
      className={`bottom-sheet placar-gaveta mobile-only ${aberta ? 'is-open' : 'is-peek'}`}
      aria-label="Placar nacional e métricas da apuração"
    >
      <div className="sheet-grip" aria-hidden="true" />

      <button
        type="button"
        className="sheet-resumo"
        onClick={onToggle}
        aria-expanded={aberta}
        aria-controls="gaveta-placar-corpo"
      >
        <span className="sheet-resumo-texto">
          <span className="sheet-resumo-kicker">
            placar nacional
            {duelo.pctApurado != null
              ? ` · ${percentual(duelo.pctApurado, 1)} apurado`
              : ''}
          </span>
          <span className="sheet-resumo-titulo">
            {lider ? (
              <>
                <b
                  className="sheet-resumo-partido"
                  style={{ color: lider.cor || undefined }}
                >
                  {lider.partido}
                </b>{' '}
                {lider.nome} {percentual(lider.pct)}
              </>
            ) : (
              'sem dados nacionais'
            )}
          </span>
          <span className="sheet-resumo-lider">
            {duelo.margemVotos != null
              ? `margem de ${numero(duelo.margemVotos)} votos (${pontos(duelo.margemPontos)} pt)`
              : 'aguardando apuração'}
          </span>
        </span>
        <span className="sheet-resumo-chevron" aria-hidden="true">
          ⌃
        </span>
      </button>

      <div className="sheet-body" id="gaveta-placar-corpo">
        <NationalScoreboard estados={estados} variante="panel" />

        <div className="panel-divider" aria-hidden="true" />

        <ul className="gaveta-metricas" aria-label="Métricas da apuração nacional">
          <Metrica
            rotulo="margem"
            valor={
              duelo.margemVotos != null ? `${numero(duelo.margemVotos)} votos` : '—'
            }
            detalhe={
              duelo.margemPontos != null
                ? `${pontos(duelo.margemPontos)} ponto · ${percentual(duelo.margemValidos)} dos válidos`
                : null
            }
          />
          <Metrica
            rotulo="votos válidos"
            valor={duelo.validos != null ? numero(duelo.validos) : '—'}
            detalhe={
              duelo.pctValidos != null
                ? `${percentual(duelo.pctValidos)} dos votos totais`
                : null
            }
          />
          <Metrica
            rotulo="participação"
            valor={
              duelo.participacao != null ? percentual(duelo.participacao) : '—'
            }
            detalhe={
              duelo.comparecimento != null && duelo.eleitores != null
                ? `${numero(duelo.comparecimento)} de ${numero(duelo.eleitores)} eleitores`
                : null
            }
          />
          <Metrica
            rotulo="seções apuradas"
            valor={
              duelo.secoesApuradas != null && duelo.secoesTotal != null
                ? `${numero(duelo.secoesApuradas)} de ${numero(duelo.secoesTotal)}`
                : '—'
            }
            detalhe={
              duelo.pctSecoes != null ? `${percentual(duelo.pctSecoes)} do total` : null
            }
          />
        </ul>

        <p className="panel-foot">
          Dados públicos do TSE. Sem cookies, sem IP, sem rastreamento.
        </p>
      </div>
    </section>
  )
}
