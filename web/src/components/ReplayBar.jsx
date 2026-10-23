import { apuracao, numero } from '../format.js'

// Barra do REPLAY da apuração: play/pause, linha do tempo, % apurado e o
// relógio do arquivo do TSE. Ela não decide nada — recebe o frame corrente e
// devolve a posição escolhida (o mapa é de quem pinta).
//
// O que é oficial e o que é derivado aparece no rodapé: relógio, % apurado e
// votos vêm do arquivo histórico do TSE; o ritmo de fechamento por UF é um
// modelo de fila declarado (o TSE não publica a série por UF).

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

function contarFechadas(replay, frame) {
  const base = replay?.ufs_base || {}
  const doFrame = frame?.ufs || {}
  let fechadas = 0
  let total = 0
  for (const sigla of Object.keys(base)) {
    // ZZ é voto no exterior: está no arquivo do TSE, não é UF e não é
    // desenhado no mapa — contar ele faria o painel dizer 28 UFs.
    if (!/^[A-Z]{2}$/.test(sigla) || sigla === 'ZZ') continue
    total += 1
    const apuradas = Number(doFrame[sigla]) || 0
    const secoesTotal = Number(base[sigla]?.secoes_total) || 0
    if (secoesTotal > 0 && apuradas >= secoesTotal) fechadas += 1
  }
  return { fechadas, total }
}

export default function ReplayBar({
  replay,
  indice,
  tocando,
  carregando,
  erro,
  onIndice,
  onPlayPause,
  onFechar,
}) {
  const frames = replay?.frames || []
  const total = frames.length
  const frame = total > 0 ? frames[Math.min(Math.max(indice, 0), total - 1)] : null
  const { fechadas, total: totalUfs } = contarFechadas(replay, frame)
  const derivado = Array.isArray(replay?.derivado) && replay.derivado.length > 0

  return (
    <section className="replay-bar" aria-label="Replay da apuração">
      <div className="replay-head">
        <span className="replay-tag">replay {replay?.modo || '2022'}</span>
        {frame ? (
          <span className="replay-resumo">
            {numero(frame.secoes_apuradas)} de {numero(frame.secoes_total)} seções
          </span>
        ) : (
          <span className="replay-resumo">carregando a série do TSE…</span>
        )}
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
          <div className="replay-numeros">
            <div className="replay-numero">
              <strong data-prova="replay-pct">
                {frame ? apuracao(frame.pct_apurado) : carregando ? '…' : '—'}
              </strong>
              <span>apurado</span>
            </div>
            <div className="replay-numero">
              <strong data-prova="replay-relogio">
                {relogioDoArquivo(frame?.em)}
              </strong>
              <span>arquivo do TSE</span>
            </div>
            <div className="replay-numero">
              <strong data-prova="replay-fechadas">
                {totalUfs ? `${fechadas}/${totalUfs}` : '—'}
              </strong>
              <span>UFs fechadas</span>
            </div>
          </div>

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
              value={Math.min(indice, Math.max(total - 1, 0))}
              onChange={(evento) => onIndice(Number(evento.target.value))}
              aria-label="Linha do tempo da apuração"
              data-prova="replay-linha"
              disabled={!total}
            />
            <span className="replay-posicao">
              {total ? `${Math.min(indice + 1, total)}/${total}` : '—'}
            </span>
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
