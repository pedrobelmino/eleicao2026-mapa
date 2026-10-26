import { navega } from '../../router.jsx'
import { corDoLider, pct, semSecaoApurada } from './formato.js'

// Mapa estático do momento, desenhado a partir de publico.mapa. A cor é o
// CANDIDATO que lidera em cada UF — PL azul, PT vermelho, regra fixa — e a
// opacidade cresce com o % apurado. Lula à frente numa UF pinta VERMELHO:
// a cor nunca é "de quem está ganhando", é do candidato.
// UF sem seção apurada fica neutra, sem candidato. O link grande leva ao mapa
// interativo, que é o produto final.
export default function MapaMomento({ dados }) {
  const mapa = dados.mapa || {}
  const ufs = mapa.ufs || {}

  if (dados.sem_dado || !Object.keys(ufs).length) return null

  const porUf = {}
  for (const uf of dados.ufs || []) porUf[uf.uf] = uf

  return (
    <>
      <svg
        className="figura"
        viewBox={mapa.viewBox}
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Mapa do Brasil colorido pelo candidato que lidera em cada estado"
      >
        {Object.entries(ufs).map(([sigla, geometria]) => {
          const info = porUf[sigla] || {}
          const espera = semSecaoApurada(info)
          const lider = info.lider
          const cor = espera ? '#b9b2a4' : corDoLider(info)
          const apurado = Number(info.pct_apurado) || 0
          const opacidade = espera
            ? 0.22
            : 0.3 + 0.7 * Math.min(1, apurado / 100)

          return (
            <path
              key={sigla}
              d={geometria.d}
              fill={cor}
              fillOpacity={opacidade.toFixed(2)}
              stroke="#fffdf8"
              strokeWidth="1.1"
            >
              <title>
                {espera
                  ? `${sigla} — sem seções apuradas ainda`
                  : `${sigla} — ${lider || 'sem dado'} ${pct(
                      info.lider_pct,
                    )}%`}
              </title>
            </path>
          )
        })}
      </svg>

      <p className="nota">
        Cor = candidato que lidera no estado. Opacidade = parte das seções já
        apuradas. Estado sem seção apurada fica neutro. Geometria pública;
        números do TSE.
      </p>

      <a
        className="mapa-cta"
        href="/mapa"
        onClick={(evento) => {
          evento.preventDefault()
          navega('/mapa')
        }}
      >
        abrir o mapa interativo →
      </a>
    </>
  )
}
