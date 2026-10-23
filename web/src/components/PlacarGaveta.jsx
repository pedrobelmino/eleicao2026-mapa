// Gaveta do placar (só no celular): o painel do desktop cabe numa bottom-sheet.
//
// FECHADA é só uma ABA de 40 px com a alça e o rótulo "placar nacional" — sem
// resumo de líder nem percentual: essa informação já está na barra fina do
// topo, e repetir aqui era o que fazia aparecer dois painéis informativos
// empilhados na tela do celular. O card do placar só existe quando o usuário
// puxa a aba (`is-open`): aí vêm o placar do painel + as quatro métricas que o
// desktop tem na lateral (margem, válidos, participação e seções apuradas).
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
      data-prova="gaveta-placar"
    >
      <div className="sheet-grip" aria-hidden="true" />

      <button
        type="button"
        className="sheet-resumo"
        onClick={onToggle}
        aria-expanded={aberta}
        aria-controls="gaveta-placar-corpo"
        data-prova="gaveta-alca"
      >
        <span className="sheet-resumo-texto">
          <span className="sheet-resumo-kicker">
            {aberta
              ? `placar nacional${
                  duelo.pctApurado != null
                    ? ` · ${percentual(duelo.pctApurado, 1)} apurado`
                    : ''
                }`
              : 'placar nacional'}
          </span>
          {/* Fechada não repete nada: o resumo do líder é o da barra do topo. */}
          {aberta ? (
            <>
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
            </>
          ) : null}
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
