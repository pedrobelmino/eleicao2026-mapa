import { motivoDoBloqueio } from '../recorte.js'

// AVISO DE RECORTE — aparece DENTRO do mapa quando a camada de zona/local que
// a API serve é de outro turno/eleição que o painel está exibindo.
//
// Duas responsabilidades, nada além:
//   1. dizer o motivo (o TSE só publica o dump por seção ao final do turno) —
//      sem isso o mapa parece "sem dado" e o silêncio vira suspeita;
//   2. oferecer o toggle explícito para ver o turno anterior, sempre com um
//      selo berrante dizendo de qual turno é o que está na tela.
//
// O estado do toggle mora no MapWorkspace (quem sabe se a camada está oculta).
export default function AvisoRecorte({ recorte, verAnterior, onAlternar }) {
  if (!recorte?.divergente) return null

  const rotulo = recorte.rotuloFonte || 'turno anterior'

  return (
    <div
      className={`aviso-recorte${verAnterior ? ' is-liberado' : ''}`}
      role="status"
      aria-live="polite"
      data-prova="aviso-recorte"
      data-turno-fonte={recorte.turno ?? ''}
      data-eleicao-fonte={recorte.eleicao || ''}
      data-turno-painel={recorte.painelTurno ?? ''}
    >
      <div className="aviso-recorte-texto">
        {verAnterior ? (
          <span className="aviso-recorte-selo" data-prova="selo-turno-fonte">
            {rotulo}
            {recorte.eleicao ? ` · eleição ${recorte.eleicao}` : ''}
          </span>
        ) : null}
        <p>{motivoDoBloqueio(recorte)}</p>
      </div>

      <button
        type="button"
        className="aviso-recorte-acao"
        onClick={onAlternar}
        aria-pressed={Boolean(verAnterior)}
        data-prova="aviso-recorte-toggle"
      >
        {verAnterior ? 'voltar ao mapa por UF' : `ver zonas do ${rotulo}`}
      </button>
    </div>
  )
}
