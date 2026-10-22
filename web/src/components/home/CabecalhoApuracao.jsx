import { milhar, pct } from './formato.js'

const ANDAMENTO = {
  f: 'apuração encerrada',
  s: 'apuração em andamento',
  n: 'apuração não iniciada',
}

// Cabeçalho da apuração: turno, andamento, seções apuradas, votos válidos e o
// arquivo do TSE usado no retrato. Quando há próximo turno, mostra o aviso.
export default function CabecalhoApuracao({ dados }) {
  const nacional = dados.nacional || {}
  const andamento = ANDAMENTO[dados.andamento] || 'sem informação'
  const proximo = dados.proximo

  return (
    <>
      <div className="card">
        <h2>{dados.turno} · TSE</h2>
        <div className="legenda" style={{ margin: 0, gap: '10px 22px' }}>
          <span>
            <b style={{ background: 'var(--teal)' }} />
            {andamento}
          </span>
          <span>
            {pct(nacional.pct_apurado)}% das seções apuradas (
            {milhar(nacional.st)} de {milhar(nacional.ts)})
          </span>
          <span>{milhar(nacional.vv)} votos válidos</span>
          <span>
            arquivo do TSE de {dados.fonte_gerada_texto || '—'}
          </span>
        </div>
      </div>

      {proximo ? (
        <div className="aviso">
          <b>{proximo.turno}:</b> a apuração ainda não começou no TSE (
          {milhar(proximo.st)} de {milhar(proximo.ts)} seções). O placar abaixo é
          o {dados.turno}, já encerrado — atualização do painel em{' '}
          {String(dados.gerado_em || '')
            .slice(0, 16)
            .replace('T', ' ')}
          .
        </div>
      ) : null}
    </>
  )
}
