// Estado de espera do painel: o retrato em disco NÃO é do turno exibido.
//
// Usado em /eleicao (no lugar dos cards) e em /mapa (no lugar do workspace).
// Existe porque servir número do turno anterior com o rótulo do turno novo é o
// pior defeito possível deste projeto — quando a API responde
// `incoerente: true` / `sem_dado: true`, a tela diz que está esperando em vez
// de mostrar 100% de uma apuração que já passou.
import { rotuloTurno } from '../atualizacao.js'
import './aguardando.css'

// Texto fixo, sem ordinal do turno anterior. Só sai daqui quando o TSE
// publicar o primeiro arquivo do turno — o ciclo de atualização roda sozinho e
// a troca não pede reload.
const TEXTO =
  'Aguardando o processamento do TSE — a apuração do 2º turno já vai iniciar. Esta página se atualiza sozinha.'

export default function AguardandoTSE({ eleicao = null, turno = null, variante = 'home' }) {
  const identificacao = [eleicao ? `eleição ${eleicao}` : null, turno ? rotuloTurno(turno) : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className={`aguardando-tse aguardando-tse--${variante}`}
      data-prova="aguardando-tse"
      role="status"
      aria-live="polite"
    >
      <span className="aguardando-pulso" aria-hidden="true" />
      <p className="aguardando-texto">{TEXTO}</p>
      <p className="aguardando-meta">
        {identificacao ? `${identificacao} · ` : ''}
        nenhum percentual aparece aqui até o primeiro arquivo do TSE chegar
      </p>
    </div>
  )
}
