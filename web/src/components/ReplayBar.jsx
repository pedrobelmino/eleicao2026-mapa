import { apuracao, numero } from '../format.js'

// Barra do REPLAY DA APURAÇÃO: toca a apuração preenchendo o mapa, passo a
// passo, com o % apurado grande, o carimbo do passo, as UFs fechando, o placar
// acompanhando e o seletor de velocidade (1x/8x/60x).
//
// De onde vem cada coisa (e é isso que a nota do rodapé diz na tela):
//   - 2026 (padrão): série montada pelo backend a partir do dump do TSE POR
//     SEÇÃO. O dump não traz o horário de fechamento de cada seção, então o
//     eixo é a ORDEM DAS SEÇÕES e o campo "carimbo" mostra o passo (não há
//     horário do TSE para mostrar, e horário não se inventa).
//   - 2022 (histórico): série nacional oficial do TSE, com relógio real ponto a
//     ponto. Os votos são reais; o ritmo por UF é o modelo de fila rotulado.
//
// A barra não decide nada: recebe o passo corrente e devolve a posição
// escolhida. Quem pinta o mapa é o MapView.

function relogioDoArquivo(em) {
  if (!em) return '—'
  // "2022-10-02T17:04:47" — hora de Brasília, sem fuso no arquivo.
  const texto = String(em)
  const [data, hora = ''] = texto.split('T')
  const partes = data.split('-')
  if (partes.length !== 3) return texto
  const [ano, mes, dia] = partes
  const hhmm = hora.slice(0, 5)
  return `${dia}/${mes}/${ano} ${hhmm}`.trim()
}

function contarFechadas(replay, passo) {
  const base = replay?.ufs_base || {}
  const doPasso = passo?.uf || {}
  let fechadas = 0
  let total = 0
  for (const sigla of Object.keys(base)) {
    // ZZ é voto no exterior: está no arquivo do TSE, não é UF e não é
    // desenhado no mapa — contar ele faria o painel dizer 28 UFs.
    if (!/^[A-Z]{2}$/.test(sigla) || sigla === 'ZZ') continue
    total += 1
    const apuradas = Number(doPasso[sigla]) || 0
    const secoesTotal = Number(base[sigla]?.secoes_total) || 0
    if (secoesTotal > 0 && apuradas >= secoesTotal) fechadas += 1
  }
  return { fechadas, total }
}

const VELOCIDADES = [
  { rotulo: '1x', fator: 1 },
  { rotulo: '8x', fator: 8 },
  { rotulo: '60x', fator: 60 },
]

export default function ReplayBar({
  replay,
  passos,
  indice,
  tocando,
  velocidade,
  fonte,
  carregando,
  erro,
  onIndice,
  onPlayPause,
  onVelocidade,
  onFonte,
  onFinal,
  onFechar,
}) {
  const total = passos.length
  const posicao = total > 0 ? Math.min(Math.max(indice, 0), total - 1) : 0
  const passo = total > 0 ? passos[posicao] : null
  const { fechadas, total: totalUfs } = contarFechadas(replay, passo)
  const derivado = Array.isArray(replay?.derivado) && replay.derivado.length > 0
  const comRelogio = Boolean(passo?.t)
  const placar = (passo?.placar || []).slice(0, 2)
  const noFim = total > 0 && posicao >= total - 1
  const carimbo = passo
    ? comRelogio
      ? relogioDoArquivo(passo.t)
      : `${posicao + 1}/${total}`
    : '—'

  return (
    <section className="replay-bar" aria-label="Replay da apuração">
      <div className="replay-head">
        <span className="replay-tag">replay</span>
        <div className="replay-fontes" role="group" aria-label="Série do replay">
          <button
            type="button"
            className={`replay-fonte${fonte === 'apuracao' ? ' is-ativo' : ''}`}
            onClick={() => onFonte('apuracao')}
            aria-pressed={fonte === 'apuracao'}
            data-prova="replay-fonte-apuracao"
          >
            apuração 2026
          </button>
          <button
            type="button"
            className={`replay-fonte${fonte === '2022' ? ' is-ativo' : ''}`}
            onClick={() => onFonte('2022')}
            aria-pressed={fonte === '2022'}
            data-prova="replay-fonte-2022"
          >
            2022
          </button>
        </div>
        <button
          type="button"
          className="replay-sair"
          onClick={onFechar}
          aria-label="Sair do replay"
        >
          ×
        </button>
      </div>

      {erro ? (
        <p className="replay-erro">{erro}</p>
      ) : (
        <>
          <div className="replay-apurado">
            <strong data-prova="replay-pct">
              {passo ? apuracao(passo.pct) : carregando ? '…' : '—'}
            </strong>
            <span>apurado</span>
          </div>

          <div className="replay-numeros">
            <div className="replay-numero">
              <strong data-prova="replay-relogio">{carimbo}</strong>
              <span>{comRelogio ? 'arquivo do TSE' : 'passo (sem relógio do TSE)'}</span>
            </div>
            <div className="replay-numero">
              <strong data-prova="replay-fechadas">
                {totalUfs ? `${fechadas}/${totalUfs}` : '—'}
              </strong>
              <span>UFs fechadas</span>
            </div>
            <div className="replay-numero replay-numero--secoes">
              <strong data-prova="replay-secoes">
                {passo ? numero(passo.secoes) : '—'}
              </strong>
              <span>seções apuradas</span>
            </div>
          </div>

          {placar.length > 0 ? (
            <div className="replay-placar" data-prova="replay-placar">
              {placar.map((candidato, ordem) => (
                <div
                  className={`replay-placar-linha${ordem === 0 ? ' is-lider' : ''}`}
                  key={`${candidato.nome}-${ordem}`}
                >
                  <span className="replay-placar-nome">{candidato.nome}</span>
                  <b data-prova={`replay-votos-${ordem}`}>{numero(candidato.votos)}</b>
                  <i data-prova={`replay-pct-${ordem}`}>{apuracao(candidato.pct)}</i>
                </div>
              ))}
            </div>
          ) : null}

          <div className="replay-controles">
            <button
              type="button"
              className="replay-play"
              onClick={onPlayPause}
              aria-label={tocando ? 'Pausar o replay' : 'Tocar o replay'}
              data-prova="replay-play"
            >
              {tocando ? '❚❚' : '▶'}
            </button>
            <input
              className="replay-linha"
              type="range"
              min={0}
              max={Math.max(total - 1, 0)}
              step={1}
              value={posicao}
              onChange={(evento) => onIndice(Number(evento.target.value))}
              aria-label="Linha do tempo da apuração"
              data-prova="replay-linha"
              disabled={!total}
            />
            <span className="replay-posicao">
              {total ? `${posicao + 1}/${total}` : '—'}
            </span>
          </div>

          <div className="replay-rodape">
            <div className="replay-velocidades" role="group" aria-label="Velocidade do replay">
              {VELOCIDADES.map((item) => (
                <button
                  type="button"
                  key={item.rotulo}
                  className={`replay-velocidade${velocidade === item.fator ? ' is-ativo' : ''}`}
                  onClick={() => onVelocidade(item.fator)}
                  aria-pressed={velocidade === item.fator}
                  data-prova={`replay-vel-${item.rotulo}`}
                >
                  {item.rotulo}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="replay-final"
              onClick={onFinal}
              disabled={!total || noFim}
              data-prova="replay-final"
            >
              final (100%)
            </button>
          </div>

          <p className="replay-nota">
            {derivado
              ? `Real: ${(replay?.real || []).slice(0, 3).join(', ')}. Derivado: ${replay.derivado[0]}.`
              : 'Cada ponto é uma coleta real, sem interpolação.'}
          </p>
        </>
      )}
    </section>
  )
}
