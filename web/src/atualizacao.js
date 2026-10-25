import { useCallback, useEffect, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// ATUALIZAÇÃO AUTOMÁTICA DOS DADOS (sem reload de página)
//
// Regra do painel: o DADO se atualiza sozinho, a PÁGINA nunca. Não existe
// `location.reload()` aqui e não existe segundo bundle: o ciclo refaz o fetch
// das rotas de dados e troca o estado do React. Quem está com a aba aberta às
// 17h vê o 2º turno começar sem apertar nada e sem perder o que estava vendo.
//
// Cadência (escolhida, medida contra o rate limit do site — 40 r/s por IP no
// nginx e 300/10 s na borda):
//   * apuração parada / encerrada: 60 s;
//   * apuração em andamento (0 < pct < 100): 30 s, que é a janela em que o
//     número muda de verdade na tela;
//   * aba oculta: ZERO requisição (o timer é desarmado, não só ignorado);
//     ao voltar, um fetch imediato e a cadência religa.
// Um ciclo por PÁGINA (uma única cadeia de setTimeout), nunca um por
// componente: o painel do mapa tem cinco widgets e continua gastando uma
// rajada só por rodada.
// ---------------------------------------------------------------------------

export const INTERVALO_PARADO_MS = 60_000
export const INTERVALO_APURANDO_MS = 30_000

// `pct` = percentual apurado do turno que está na tela; `turno` = turno do
// DADO exibido (1 ou 2); `semDado` = a API avisou que não há arquivo do turno;
// `incoerente` = a API avisou que o retrato em disco é de OUTRO turno.
// Devolve a fase do BANNER, que é o que o usuário lê:
//   aguardando -> o TSE ainda não publicou voto do turno corrente;
//   andamento  -> tem voto chegando;
//   concluida  -> o turno na tela fechou em 100%.
//
// REGRA DE OURO: "concluída" e "em andamento" só podem aparecer quando o turno
// do DADO é o turno do painel. Se a API diz `incoerente`, o número que está no
// disco é de outro turno e não existe frase honesta de percentual para ele —
// a fase cai para `aguardando`, sempre.
//
// TURNO DESCONHECIDO = `turno: null`. Antes do primeiro fetch não existe dado,
// então não existe turno — e o banner NÃO pode afirmar ordinal nenhum nessa
// hora (era daqui que saía o "aguardando ... do 1º turno" na primeira
// renderização). `turno` só carrega 1 ou 2 quando o DADO diz qual é.
export function estadoDaApuracao({ pct, turno, semDado, incoerente } = {}) {
  const texto = String(turno ?? '').trim()
  const digitos = texto.replace(/\D/g, '')
  const numeroTurno = digitos === '' ? null : Number(digitos) >= 2 ? 2 : 1
  const bruto = pct == null || pct === '' ? NaN : Number(pct)
  const temPct = Number.isFinite(bruto)
  const valor = temPct ? bruto : 0

  if (incoerente) {
    return { fase: 'aguardando', turno: null, pct: 0 }
  }
  if (semDado || !temPct || !(valor > 0)) {
    return { fase: 'aguardando', turno: null, pct: valor }
  }
  if (valor >= 99.995) {
    // Turno 1 em 100%: o próximo dado esperado é a apuração do 2º turno.
    if (numeroTurno === 2) return { fase: 'concluida', turno: 2, pct: valor }
    return { fase: 'aguardando', turno: null, pct: valor }
  }
  return { fase: 'andamento', turno: numeroTurno, pct: valor }
}

export function rotuloTurno(numero) {
  return `${numero}º turno`
}

function doisDigitos(n) {
  return String(n).padStart(2, '0')
}

// HH:MM — o carimbo curto do banner.
export function horaCurta(data) {
  if (!(data instanceof Date) || Number.isNaN(data.getTime())) return null
  return `${doisDigitos(data.getHours())}:${doisDigitos(data.getMinutes())}`
}

// HH:MM:SS — a prova de que a última leitura é recente (e não a de ontem).
export function horaComSegundos(data) {
  if (!(data instanceof Date) || Number.isNaN(data.getTime())) return null
  return `${horaCurta(data)}:${doisDigitos(data.getSeconds())}`
}

function abaOculta() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

// O ciclo. `aoCiclar` devolve `true` (dado novo em tela), `false` (falhou e o
// último dado bom continua) ou uma Promise de qualquer um dos dois.
//
// Contrato de falha: uma atualização que falha NUNCA esvazia a tela — quem
// chama mantém o estado anterior e o hook só levanta `falha`, que o banner
// mostra como "sem conexão — tentando de novo".
export function useAtualizacaoAutomatica({
  aoCiclar,
  intervaloMs = INTERVALO_PARADO_MS,
  habilitado = true,
} = {}) {
  const [ultimaLeitura, setUltimaLeitura] = useState(null)
  const [falha, setFalha] = useState(false)
  const [ciclos, setCiclos] = useState(0)
  const [pausada, setPausada] = useState(abaOculta)

  const refCiclar = useRef(aoCiclar)
  refCiclar.current = aoCiclar
  const refIntervalo = useRef(intervaloMs)
  refIntervalo.current = intervaloMs

  const timerRef = useRef(null)
  // Trava de reentrância: um ciclo lento (o /api/replay leva ~1 s) não pode
  // empilhar com o próximo.
  const emVooRef = useRef(false)
  const vivoRef = useRef(true)

  useEffect(() => {
    vivoRef.current = true
    return () => {
      vivoRef.current = false
    }
  }, [])

  const registrarLeitura = useCallback(() => {
    if (!vivoRef.current) return
    setUltimaLeitura(new Date())
    setFalha(false)
  }, [])

  const registrarFalha = useCallback(() => {
    if (!vivoRef.current) return
    setFalha(true)
  }, [])

  const executar = useCallback(async () => {
    // Duas guardas antes de qualquer requisição: nada em paralelo e nada com
    // a aba em segundo plano (o navegador estrangula timers de aba oculta,
    // mas o fetch imediato do visibilitychange passaria por aqui).
    if (emVooRef.current || abaOculta()) return null
    emVooRef.current = true
    try {
      const resultado = await refCiclar.current()
      if (!vivoRef.current) return resultado
      setCiclos((n) => n + 1)
      if (resultado === false) setFalha(true)
      else {
        setFalha(false)
        setUltimaLeitura(new Date())
      }
      return resultado
    } catch {
      if (vivoRef.current) {
        setCiclos((n) => n + 1)
        setFalha(true)
      }
      return false
    } finally {
      emVooRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!habilitado || typeof document === 'undefined') return undefined

    let vivo = true
    const desarmar = () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    // Cadeia de setTimeout (não setInterval): o intervalo pode mudar no meio
    // (60 s -> 30 s quando a apuração começa) sem reiniciar o efeito, e dois
    // ciclos nunca ficam armados ao mesmo tempo.
    const agendar = () => {
      if (!vivo) return
      desarmar()
      timerRef.current = setTimeout(async () => {
        await executar()
        agendar()
      }, refIntervalo.current)
    }

    const aoMudarVisibilidade = () => {
      const oculta = abaOculta()
      setPausada(oculta)
      if (oculta) {
        // Aba em segundo plano: timer desarmado, nenhuma requisição.
        desarmar()
        return
      }
      // Voltou para a frente: busca JÁ (o dado não pode ficar velho na tela
      // de quem acabou de olhar) e só depois religa a cadência.
      executar().finally(() => {
        if (vivo) agendar()
      })
    }

    document.addEventListener('visibilitychange', aoMudarVisibilidade)
    if (abaOculta()) {
      setPausada(true)
      desarmar()
    } else {
      setPausada(false)
      agendar()
    }

    return () => {
      vivo = false
      desarmar()
      document.removeEventListener('visibilitychange', aoMudarVisibilidade)
    }
  }, [habilitado, executar])

  // Handle de prova (scripts/provas/autorefresh.mjs): o que o ciclo fez, sem
  // abrir o devtools. `forcar()` roda o ciclo agora, para a prova não esperar
  // 60 s; o temporizador é desarmado antes e rearmado depois.
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__autoRefresh = {
      ciclos,
      falha,
      pausada,
      intervaloMs,
      ultimaLeitura: ultimaLeitura ? ultimaLeitura.toISOString() : null,
      forcar: () => executar(),
      estado: () => ({
        ciclos,
        falha,
        pausada,
        intervaloMs,
        timeOrigin: performance.timeOrigin,
        agora: performance.now(),
      }),
    }
  }, [ciclos, falha, pausada, intervaloMs, ultimaLeitura, executar])

  return {
    ultimaLeitura,
    falha,
    ciclos,
    pausada,
    intervaloMs,
    atualizarAgora: executar,
    registrarLeitura,
    registrarFalha,
  }
}
