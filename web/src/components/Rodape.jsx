import { dataHora } from '../format.js'

// Créditos e privacidade em um só lugar: as duas rotas (home e mapa) mostram
// o mesmo bloco, então fonte oficial, créditos do mapa base e aviso de
// privacidade nunca divergem entre páginas.
//
// No mapa a faixa é curta de propósito: ela come altura do mapa, então usa a
// versão de uma linha por item. Na home o texto pode ser completo.
const PORTAL_TSE = 'https://resultados.tse.jus.br/'
const OSM = 'https://www.openstreetmap.org/copyright'
const CARTO = 'https://carto.com/attributions'
const CANAL = 'https://www.youtube.com/@belmino.c.f'

function link(href, texto) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {texto}
    </a>
  )
}

export default function Rodape({
  eleicao,
  turno,
  geradoEm,
  municipalAviso = null,
  dadosAviso = null,
  variante = 'mapa',
  mostrarCanal = true,
}) {
  const curto = variante === 'mapa'
  const identificacao = [
    eleicao ? `eleição ${eleicao}` : null,
    turno || null,
    geradoEm && !curto ? `atualizado ${dataHora(geradoEm)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <footer className={`rodape-site rodape-site--${variante}`}>
      {dadosAviso ? (
        // Snapshot nacional/UF de outro turno (janela entre a virada e o
        // primeiro voto publicado). Sem esta linha o placar apareceria com o
        // rótulo do turno novo e números do anterior.
        <p className="rodape-aviso-dado" data-prova="dados-aviso">
          <b>Atenção</b> {dadosAviso}
        </p>
      ) : null}
      {municipalAviso ? (
        // Dado municipal/urna vem do dump por seção, que o TSE só publica ao
        // final de cada turno. Quando o arquivo em disco é de outro turno, a
        // tela diz isso — nunca mostra número de outro turno como se fosse o
        // do turno em exibição.
        <p className="rodape-aviso-dado" data-prova="municipal-aviso">
          <b>Atenção</b> {municipalAviso}
        </p>
      ) : null}
      <p>
        <b>Fonte</b> dados oficiais do TSE · {link(PORTAL_TSE, 'resultados.tse.jus.br')}
        {identificacao ? ` · ${identificacao}` : null}
      </p>
      <p>
        <b>Mapa</b> {curto ? '© ' : 'malhas do IBGE · mapa base © '}
        {link(OSM, 'OpenStreetMap')} · © {link(CARTO, 'CARTO')}
      </p>
      <p>
        <b>{curto ? 'Privacidade' : 'Privacidade'}</b>{' '}
        {curto
          ? 'sem cookies, sem IP, visitas contadas de forma anônima'
          : 'sem cookies, sem IP, sem rastreamento — a contagem de visitas é anônima (hash do dia, sem endereço)'}
      </p>
      {mostrarCanal ? (
        <p>
          <b>Canal</b> {link(CANAL, '@belmino.c.f')} no YouTube
        </p>
      ) : null}
    </footer>
  )
}
