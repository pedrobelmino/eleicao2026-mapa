// A legenda fala de UM nível por vez: com o zoom mudando a camada que está na
// frente, misturar "zona" e "município" na mesma tela confunde. Os limites são
// os mesmos usados pelas camadas do MapView (importados de mapa.js).
//
// Régua de níveis (a mesma de nivelPorZoom, em mapa.js):
//   macro (zoom < ZOOM_ZONA)         -> UF colorida por MARGEM
//   estado (ZOOM_ZONA..MUNICIPIO)    -> ZONA eleitoral, prisma de 4 segmentos
//   município (MUNICIPIO..LOCAL)     -> cor do líder no MUNICÍPIO
//   local (>= ZOOM_LOCAL)            -> urna
//
// A regra do concreto só vale onde há cor de candidato disputando com apuração
// parcial (macro e estado) — por isso o texto dela aparece só nesses níveis.
import { useState } from 'react'
import {
  COR_CONCRETO,
  CORES_PARTIDO,
  NIVEIS_ZOOM_TEXTO,
  PONTOS_CORTE_MARGEM,
  ZOOM_BARRA_ZONA_FIM,
  nivelPorZoom,
  ROTULO_NIVEL,
} from '../mapa.js'

// Cor de cada ponto de corte da escala divergente do calor por município. É a
// MESMA rampa de EXPRESSAO_CALOR_MUNICIPIO (mapa.js) nas mesmas paradas — a
// legenda não inventa um degradê: mostra os cortes onde a cor muda.
const CORES_CORTE_MARGEM = [
  '#7a0a1c',
  '#c04a5e',
  '#e9a3ac',
  '#efe9dc',
  '#a8c1e2',
  '#4a7cbe',
  '#0b2b5e',
]

// Nome curto do nível para o chip (o título completo fica no corpo da legenda,
// que no celular nasce recolhido).
const NIVEL_CURTO = {
  macro: 'UF',
  zona: 'zona',
  municipio: 'município',
  local: 'local',
}

const TEXTOS = {
  macro: {
    titulo: 'estado (UF) — margem',
    mostraBarra: true,
    mostraSegmentos: false,
    regraConcreto: true,
    itens: [
      'cor = partido do líder na UF',
      'tonalidade = margem do líder em pontos (0 a 40+)',
      'toque na UF = abrir as zonas eleitorais',
    ],
  },
  zona: {
    titulo: 'zona eleitoral — composição',
    mostraBarra: false,
    mostraSegmentos: true,
    regraConcreto: true,
    itens: [
      'altura do prisma = votos válidos da zona',
      'os 4 segmentos empilhados dividem esses votos (abaixo)',
      'toque no prisma = detalhe da zona',
    ],
  },
  municipio: {
    titulo: 'município',
    mostraBarra: true,
    mostraSegmentos: true,
    regraConcreto: true,
    itens: [
      'cor = partido do líder no município',
      'tonalidade = margem do líder em pontos (0 a 40+)',
      'as barras das zonas continuam na tela (mesma composição)',
      'toque no município = abrir locais de votação',
    ],
  },
  local: {
    titulo: 'local de votação — cidade-urna',
    mostraBarra: false,
    mostraSegmentos: false,
    regraConcreto: false,
    itens: [
      'cada prédio = um local de votação',
      'altura = votos válidos do local',
      'cor = partido do candidato que lidera',
      'topo em concreto = seções ainda não apuradas',
      'toque no prédio = urnas (seções) do local',
    ],
  },
}

// Os 4 segmentos empilhados da barra de composição da zona, na ordem em que
// sobem no prisma (base -> topo). As cores são as mesmas do MapView: se mudar
// lá, muda aqui.
const SEGMENTOS_ZONA = [
  { rotulo: 'Lula (PT)', cor: CORES_PARTIDO.PT },
  { rotulo: 'Flávio (PL)', cor: CORES_PARTIDO.PL },
  { rotulo: 'outros', cor: '#6b7280' },
  { rotulo: 'não apurado', cor: COR_CONCRETO },
]

export const REGRA_CONCRETO =
  'regra do concreto: UF com apuração em andamento não recebe cor de ' +
  'candidato — fica em cinza-concreto até secoes_apuradas = secoes_total.'

// No zoom macro o nível do mapa é 'estado' (a UF é a unidade visível), mas o
// texto da legenda é o da margem; por isso a chave própria 'macro'.
export function chaveDoZoom(zoom) {
  const nivel = nivelPorZoom(zoom)
  return nivel === 'estado' ? 'macro' : nivel
}

export default function Legend({ zoom, modoMargem }) {
  const chave = chaveDoZoom(zoom)
  // Sem fallback, uma chave nova derrubava o componente inteiro (e o mapa com
  // ele). A legenda agora nunca fica sem texto.
  const texto = TEXTOS[chave] || {
    titulo: ROTULO_NIVEL[nivelPorZoom(zoom)] || String(chave),
    mostraBarra: true,
    mostraSegmentos: false,
    regraConcreto: false,
    itens: ['cor = partido do líder', 'tonalidade = margem do líder (pontos)'],
  }

  // No nível local as barras de zona convivem com os prédios até
  // ZOOM_BARRA_ZONA_FIM; só depois disso a lista de segmentos deixa a tela.
  const zoomNumero = Number(zoom)
  const barrasDeZonaVisiveis =
    chave === 'local' &&
    Number.isFinite(zoomNumero) &&
    zoomNumero < ZOOM_BARRA_ZONA_FIM
  const mostraSegmentos = texto.mostraSegmentos || barrasDeZonaVisiveis
  const itens = barrasDeZonaVisiveis
    ? [...texto.itens, 'até z≈12.2 as barras de zona seguem no mapa']
    : texto.itens

  // No celular a legenda nasce recolhida (chip de 44 px); no desktop o chip é
  // display:none e o corpo aparece sempre — o CSS é que decide, o estado é um só.
  const [aberta, setAberta] = useState(false)

  return (
    <aside
      className={`legend${aberta ? ' legend--aberta' : ''}`}
      data-nivel={chave}
      aria-label={`Legenda do mapa — nível ${texto.titulo}`}
    >
      <button
        type="button"
        className="legend-toggle"
        onClick={() => setAberta((valor) => !valor)}
        aria-expanded={aberta}
      >
        <span className="legend-toggle-rotulo">Legenda</span>
        <span className="legend-toggle-nivel">{NIVEL_CURTO[chave] || chave}</span>
        <span className="legend-toggle-seta" aria-hidden="true">
          ⌃
        </span>
      </button>

      <div className="legend-corpo">
        <div className="legend-title">nível: {texto.titulo}</div>

        {texto.mostraBarra ? (
          <>
            <div className="legend-bar" aria-hidden="true" />
            <div className="legend-scale" aria-hidden="true">
              <span>40+</span>
              <span>margem em pontos</span>
              <span>0</span>
              <span>40+</span>
            </div>
          </>
        ) : null}

        {mostraSegmentos ? (
          <ul
            className="legend-segmentos"
            aria-label="Segmentos empilhados do prisma da zona"
          >
            {SEGMENTOS_ZONA.map((segmento) => (
              <li key={segmento.rotulo}>
                <i
                  aria-hidden="true"
                  className="legend-segmento-cor"
                  style={{ background: segmento.cor }}
                />
                {segmento.rotulo}
              </li>
            ))}
          </ul>
        ) : null}

        {modoMargem ? (
          <div className="legend-margem" data-prova="legenda-margem">
            <div className="legend-title">calor da vantagem por município</div>
            <div className="legend-cortes" aria-hidden="true">
              {PONTOS_CORTE_MARGEM.map((corte, indice) => (
                <span key={corte} className="legend-corte">
                  <i style={{ background: CORES_CORTE_MARGEM[indice] }} />
                  {corte > 0 ? `+${corte}` : corte}
                </span>
              ))}
            </div>
            <p className="legend-note legend-margem-nota">
              pontos de margem: negativo = vantagem PT, positivo = vantagem PL
            </p>
            <p className="legend-note legend-margem-nota">
              contorno tracejado = virou o partido do líder em relação a 2022
            </p>
          </div>
        ) : null}

        <div className="legend-parties" aria-hidden="true">
          <span className="legend-party legend-party--pl">PL</span>
          <span className="legend-party legend-party--pt">PT</span>
        </div>

        <ul className="legend-itens">
          {itens.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        {texto.regraConcreto ? (
          <p className="legend-regra" data-regra="concreto">
            {REGRA_CONCRETO}
          </p>
        ) : null}

        <p className="legend-note">
          níveis por zoom: {NIVEIS_ZOOM_TEXTO.join(' → ')}
        </p>
        <p className="legend-note legend-fonte">fonte: TSE — dados públicos</p>
      </div>
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
