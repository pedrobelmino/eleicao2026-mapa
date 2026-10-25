import { horaComSegundos } from '../atualizacao.js'
import '../banner.css'

// Texto da fase de espera. CONSTANTE de propósito: não depende do dado
// carregado, do turno que veio na API nem do relógio. Antes do primeiro fetch
// o painel já mostra esta frase — e ela não afirma ordinal de turno nenhum,
// porque nesse instante o estado é DESCONHECIDO. (Era daqui que saía o
// "aguardando o início da apuração do 1º turno" na primeira renderização.)
const TEXTO_ESPERA =
  'Aguardando o processamento do TSE — a apuração do 2º turno já vai iniciar. Esta página se atualiza sozinha.'

// Faixa de estado no topo do painel. Três fases + falha de rede:
//
//   aguardando  o TSE ainda não publicou voto do turno corrente
//               -> TEXTO_ESPERA (fixo, sem ordinal de turno)
//   andamento   tem voto chegando
//               -> "Apuração em andamento — atualizado às HH:MM:SS"
//   concluida   o turno na tela fechou em 100%
//               -> "Apuração concluída — 100% às HH:MM:SS"
//
// A troca de texto é só estado do React: quando o dado novo chega, o banner
// muda sozinho, sem reload. A falha de rede não esconde nada: o dado
// permanece na tela e a faixa passa a dizer "sem conexão — tentando de novo".
export default function BannerAtualizacao({
  fase = 'carregando',
  pct = 0,
  ultimaLeitura = null,
  falha = false,
  pausada = false,
}) {
  const quando = horaComSegundos(ultimaLeitura)

  let texto
  if (fase === 'andamento') {
    texto = `Apuração em andamento — atualizado às ${quando || '—'}`
  } else if (fase === 'concluida') {
    texto = `Apuração concluída — ${Number(pct).toFixed(1)}% às ${quando || '—'}`
  } else if (fase === 'aguardando') {
    texto = TEXTO_ESPERA
  } else {
    texto = TEXTO_ESPERA
  }

  let meta
  if (falha) meta = 'sem conexão — tentando de novo'
  else if (fase === 'andamento' || fase === 'concluida') {
    meta = `${Number(pct).toFixed(1)}% apurado`
  } else if (pausada) meta = 'pausado (aba em segundo plano)'
  else if (quando) meta = `última leitura ${quando}`
  else meta = 'conectando…'

  return (
    <div
      className={`banner-auto banner-auto--${fase}${falha ? ' is-falha' : ''}`}
      role="status"
      aria-live="polite"
      data-prova="banner-auto"
      data-fase={fase}
      data-falha={falha ? '1' : '0'}
      data-ultima-leitura={ultimaLeitura ? ultimaLeitura.toISOString() : ''}
    >
      <span className="banner-ponto" aria-hidden="true" />
      <span className="banner-texto">{texto}</span>
      <span className="banner-meta">{meta}</span>
    </div>
  )
}
