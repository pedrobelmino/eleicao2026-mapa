// A legenda fala de UM nível por vez: com o zoom mudando a camada que está na
// frente, misturar "zona" e "município" na mesma tela confunde. Os limites são
// os mesmos usados pelas camadas do MapView (importados de mapa.js).
import { NIVEIS_ZOOM_TEXTO, nivelPorZoom, ROTULO_NIVEL } from '../mapa.js'

const TEXTOS = {
  uf: {
    titulo: 'estado (UF)',
    mostraBarra: true,
    itens: ['cor = partido do líder', 'intensidade = margem do líder (pontos)'],
  },
  zona: {
    titulo: 'zona eleitoral',
    mostraBarra: false,
    itens: [
      'altura do prisma = votos da zona',
      'cor = partido do líder na zona',
      'toque no prisma = detalhe da zona',
    ],
  },
  municipio: {
    titulo: 'município',
    mostraBarra: true,
    itens: [
      'cor = partido do líder no município',
      'intensidade = margem do líder (pontos)',
      'toque no município = abrir locais de votação',
    ],
  },
  local: {
    titulo: 'local de votação (urna)',
    mostraBarra: false,
    itens: [
      'anel = % apurado',
      'disco sólido = 100%',
      'cluster = locais agrupados por proximidade',
      'cor = partido do líder no local',
      'toque no local = seções (urnas)',
    ],
  },
}

function chaveDoZoom(zoom) {
  const nivel = nivelPorZoom(zoom)
  return nivel === 'estado' ? 'uf' : nivel
}

export default function Legend({ zoom }) {
  const chave = chaveDoZoom(zoom)
  // Sem fallback, uma chave nova derrubava o componente inteiro (e o mapa com
  // ele). A legenda agora nunca fica sem texto.
  const texto = TEXTOS[chave] || {
    titulo: ROTULO_NIVEL[nivelPorZoom(zoom)] || String(chave),
    mostraBarra: true,
    itens: ['cor = partido do líder', 'intensidade = margem do líder (pontos)'],
  }

  return (
    <aside
      className="legend"
      data-nivel={chave}
      aria-label={`Legenda do mapa — nível ${texto.titulo}`}
    >
      <div className="legend-title">
        nível: {texto.titulo}
      </div>

      {texto.mostraBarra ? (
        <>
          <div className="legend-bar" aria-hidden="true" />
          <div className="legend-scale" aria-hidden="true">
            <span>40+</span>
            <span>0</span>
            <span>40+</span>
          </div>
          <div className="legend-parties" aria-hidden="true">
            <span className="legend-party legend-party--pl">PL</span>
            <span className="legend-party legend-party--pt">PT</span>
          </div>
        </>
      ) : (
        <div className="legend-parties" aria-hidden="true">
          <span className="legend-party legend-party--pl">PL</span>
          <span className="legend-party legend-party--pt">PT</span>
        </div>
      )}

      <ul className="legend-itens">
        {texto.itens.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <p className="legend-note">
        níveis por zoom: {NIVEIS_ZOOM_TEXTO.join(' → ')}
      </p>
      <p className="legend-note legend-fonte">fonte: TSE — dados públicos</p>
    </aside>
  )
}

export function ResumoLideres({ resumo }) {
  return (
    <div className="resumo-lideres" aria-label="Estados por partido do líder">
      <span className="resumo-item resumo-item--pl">
        <i aria-hidden="true" /> PL <strong>{resumo.PL}</strong>
      </span>
      <span className="resumo-item resumo-item--pt">
        <i aria-hidden="true" /> PT <strong>{resumo.PT}</strong>
      </span>
      {resumo.outros > 0 ? (
        <span className="resumo-item resumo-item--outros">
          <i aria-hidden="true" /> outros <strong>{resumo.outros}</strong>
        </span>
      ) : null}
      <span className="resumo-total">{resumo.total} UFs</span>
    </div>
  )
}
