import {
  CORES,
  CORES_2022,
  origemDe,
  pct,
  pontosValidos,
  resumoOrigem,
} from './formato.js'

const PALETA = CORES
const W = 720
const H = 300
const L = 46
const R = 16
const T = 18
const B = 38

const LARGURA = W - L - R
const ALTURA = H - T - B

// Gráfico de linhas da série: eixo X = % de seções apuradas e eixo Y = % de
// votos válidos de cada candidato. A matemática é a mesma da home antiga.
export default function GraficoSerie({
  pontos,
  rotulo,
  nomesPreferidos,
  cores,
  fonte,
}) {
  const ps = pontosValidos(pontos)

  if (!ps.length) {
    return <p className="vazio">sem dado da série para {rotulo}.</p>
  }

  if (ps.length === 1) {
    const ponto = ps[0]
    const candidatos = (ponto.candidatos || [])
      .map((candidato) => `${candidato.nome} ${pct(candidato.pct, 2)}%`)
      .join(' · ')
    const inicio = ponto.em || fonte || '—'

    return (
      <div className="ponto-unico">
        <div className="rot">série começa em {inicio}</div>
        <div className="val">{pct(ponto.pct_apurado, 2)}% apurado</div>
        <p className="nota">
          {candidatos || 'sem candidatos publicados'} · origem:{' '}
          <b>{origemDe(ponto)}</b>
        </p>
        <p className="nota">
          Existe 1 ponto real. A curva ganha corpo quando o TSE publicar uma
          nova parcial; nada é interpolado.
        </p>
      </div>
    )
  }

  let nomes = []
  if (rotulo !== '2022' && nomesPreferidos?.length) {
    nomes = nomesPreferidos.slice(0, 2)
  }
  if (!nomes.length) {
    const vistos = []
    for (const ponto of ps) {
      for (const candidato of ponto.candidatos || []) {
        if (!vistos.includes(candidato.nome)) vistos.push(candidato.nome)
      }
    }
    nomes = vistos.slice(0, 2)
  }

  const mapaCores = rotulo === '2022' ? CORES_2022 : cores || {}
  const corDe = (nome, indice) =>
    mapaCores[nome] || PALETA[indice % PALETA.length]

  let maxY = 0
  for (const ponto of ps) {
    for (const candidato of ponto.candidatos || []) {
      if (candidato.pct !== null && candidato.pct !== undefined) {
        maxY = Math.max(maxY, Number(candidato.pct))
      }
    }
  }
  maxY = Math.min(100, Math.max(50, Math.ceil((maxY + 3) / 10) * 10))

  const x = (valor) =>
    L +
    (LARGURA * Math.max(0, Math.min(100, Number(valor)))) / 100
  const y = (valor) =>
    T +
    ALTURA -
    (ALTURA * Math.max(0, Math.min(maxY, Number(valor)))) / maxY

  const detalhes = ps.slice(Math.max(0, ps.length - 8)).map((ponto, indice) => {
    const partes = (ponto.candidatos || [])
      .filter(
        (candidato) =>
          candidato.pct !== null && candidato.pct !== undefined,
      )
      .map((candidato) => `${candidato.nome} ${pct(candidato.pct, 2)}%`)

    return (
      <li key={`${ponto.em || 'ponto'}-${indice}`}>
        {ponto.em || '—'} — {pct(ponto.pct_apurado, 2)}% apurado ·{' '}
        {partes.join(' · ') || 'sem candidatos'} ·{' '}
        <b>{origemDe(ponto)}</b>
      </li>
    )
  })

  return (
    <>
      <div className="serie-legenda">
        {nomes.map((nome, indice) => (
          <span key={nome}>
            <b style={{ background: corDe(nome, indice) }} />
            {nome}
          </span>
        ))}
      </div>

      <svg
        className="grafico-serie"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Curva da apuração por candidato"
      >
        {[0, 1, 2, 3, 4].map((grau) => {
          const yy = T + (ALTURA * grau) / 4
          const valor = maxY * (1 - grau / 4)
          return (
            <g key={`grade-y-${grau}`}>
              <line
                x1={L}
                y1={yy.toFixed(1)}
                x2={L + LARGURA}
                y2={yy.toFixed(1)}
                stroke="rgba(28,35,43,0.13)"
                strokeWidth="1"
              />
              <text
                x={L - 8}
                y={(yy + 4).toFixed(1)}
                fill="#6d6b64"
                fontSize="11"
                textAnchor="end"
              >
                {pct(valor, 0)}%
              </text>
            </g>
          )
        })}

        {[0, 1, 2, 3, 4].map((grau) => {
          const xx = L + (LARGURA * grau) / 4
          return (
            <g key={`grade-x-${grau}`}>
              <line
                x1={xx.toFixed(1)}
                y1={T}
                x2={xx.toFixed(1)}
                y2={T + ALTURA}
                stroke="rgba(28,35,43,0.08)"
                strokeWidth="1"
              />
              <text
                x={xx.toFixed(1)}
                y={T + ALTURA + 20}
                fill="#6d6b64"
                fontSize="11"
                textAnchor="middle"
              >
                {grau * 25}%
              </text>
            </g>
          )
        })}

        <text
          x={L + LARGURA / 2}
          y={H - 4}
          fill="#6d6b64"
          fontSize="11"
          textAnchor="middle"
        >
          seções apuradas (%)
        </text>
        <text
          x="12"
          y={T + ALTURA / 2}
          fill="#6d6b64"
          fontSize="11"
          textAnchor="middle"
          transform={`rotate(-90 12 ${T + ALTURA / 2})`}
        >
          votos válidos (%)
        </text>

        {nomes.map((nome, indice) => {
          const cor = corDe(nome, indice)
          let caminho = ''
          let total = 0
          let ultimo = null

          for (const ponto of ps) {
            const achou = (ponto.candidatos || []).find(
              (candidato) => candidato.nome === nome,
            )
            if (
              !achou ||
              achou.pct === null ||
              achou.pct === undefined
            ) {
              continue
            }
            const px = x(ponto.pct_apurado)
            const py = y(achou.pct)
            caminho += `${total === 0 ? 'M' : 'L'}${px.toFixed(2)} ${py.toFixed(
              2,
            )} `
            total += 1
            ultimo = { x: px, y: py }
          }

          if (!total) return null

          const passo = Math.max(1, Math.floor(ps.length / 14))
          const circulos = []
          for (let i = 0; i < ps.length; i += passo) {
            const ponto = ps[i]
            const achou = (ponto.candidatos || []).find(
              (candidato) => candidato.nome === nome,
            )
            if (
              !achou ||
              achou.pct === null ||
              achou.pct === undefined
            ) {
              continue
            }
            const px = x(ponto.pct_apurado)
            const py = y(achou.pct)
            circulos.push(
              <circle
                key={`${nome}-${ponto.em || i}`}
                cx={px.toFixed(1)}
                cy={py.toFixed(1)}
                r="2.3"
                fill={cor}
              >
                <title>{`${ponto.em || '—'} · ${nome} ${pct(
                  achou.pct,
                  2,
                )}% · apurado ${pct(
                  ponto.pct_apurado,
                  2,
                )}% · origem ${origemDe(ponto)}`}</title>
              </circle>,
            )
          }

          return (
            <g key={nome}>
              <path
                d={caminho.trim()}
                fill="none"
                stroke={cor}
                strokeWidth="2.2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {circulos}
              {ultimo ? (
                <text
                  x={Math.min(W - 4, ultimo.x + 6).toFixed(1)}
                  y={(ultimo.y - 6).toFixed(1)}
                  fill={cor}
                  fontSize="11"
                  fontWeight="700"
                >
                  {nome}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>

      <p className="nota">
        <b>{ps.length}</b> ponto(s) reais de <b>{ps[0].em || '—'}</b> a{' '}
        <b>{ps[ps.length - 1].em || '—'}</b>. Origem: {resumoOrigem(ps)}. Sem
        interpolação entre pontos.
      </p>

      <details>
        <summary>Últimos pontos e a origem de cada um</summary>
        <ul className="lista-serie">{detalhes}</ul>
      </details>
    </>
  )
}
