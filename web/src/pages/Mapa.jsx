import { useCallback, useEffect, useRef, useState } from 'react'
import Header from '../components/Header.jsx'
import MapWorkspace from '../components/MapWorkspace.jsx'
import StateViews from '../components/StateViews.jsx'
import BannerAtualizacao from '../components/BannerAtualizacao.jsx'
import { API_BASE, fetchJSON } from '../api.js'
import Rodape from '../components/Rodape.jsx'
import AguardandoTSE from '../components/AguardandoTSE.jsx'
import { rotuloTurno } from '../format.js'
import { definirMeta } from '../meta.js'
import {
  INTERVALO_APURANDO_MS,
  INTERVALO_PARADO_MS,
  estadoDaApuracao,
  useAtualizacaoAutomatica,
} from '../atualizacao.js'

const ESTADO_INICIAL = {
  fase: 'loading',
  estados: null,
  geojson: null,
  erro: null,
}

// A rota /mapa aceita atalhos de prova/drill-down: ?uf=CE&z=6.3, ?m=<cd_tse>
// (município já aberto), ?replay=<frame> (abre o replay naquele frame) e
// ?margem=1 (abre o mapa de calor de margem + o card). Sem query, tudo
// continua como antes (Brasil inteiro, sem UF selecionada).
function lerAtalhosDaUrl() {
  if (typeof window === 'undefined') {
    return { ufInicial: null, municipioInicial: null, zoomInicial: null, replayInicial: null, margemInicial: false }
  }
  const parametros = new URLSearchParams(window.location.search)
  const ufBruta = parametros.get('uf')
  const uf = ufBruta ? ufBruta.trim().toUpperCase() : ''
  const zoomBruto = parametros.get('z')
  const zoom = zoomBruto != null && zoomBruto.trim() !== '' ? Number(zoomBruto) : NaN
  const municipioBruto = parametros.get('m')
  const municipio = municipioBruto ? municipioBruto.trim() : ''
  const replayBruto = parametros.get('replay')
  const replay =
    replayBruto != null && /^\d+$/.test(replayBruto.trim())
      ? Number(replayBruto.trim())
      : null
  const margemBruta = parametros.get('margem')

  return {
    ufInicial: /^[A-Z]{2}$/.test(uf) ? uf : null,
    municipioInicial: /^\d+$/.test(municipio) ? municipio : null,
    zoomInicial: Number.isFinite(zoom) ? zoom : null,
    replayInicial: replay,
    margemInicial: margemBruta === '1' || margemBruta === 'true',
  }
}

// Workspace do mapa interativo. Só é montado na rota /mapa, então a home não
// dispara as buscas de /api/estados e /api/ufs.geojson.
export default function Mapa() {
  const [atalhos] = useState(lerAtalhosDaUrl)
  const [dados, setDados] = useState(ESTADO_INICIAL)
  const [tentativa, setTentativa] = useState(0)
  // Passo do replay enquanto ele corre: o cabeçalho do site mostra o % e o
  // carimbo DO PASSO (não o arquivo fechado). `null` = replay fechado.
  const [aoVivo, setAoVivo] = useState(null)
  // Contador que sobe a cada ciclo automático. O workspace usa isto como chave
  // de invalidação dos painéis que têm cache próprio (margens por UF, série do
  // replay) — nenhum deles perde posição por causa disto: é número, não dado.
  const [versao, setVersao] = useState(0)

  const dadosRef = useRef(dados)
  dadosRef.current = dados

  const apuracao = estadoDaApuracao({
    pct: dados.estados?.nacional?.pct_apurado,
    turno: dados.estados?.dados_turno ?? dados.estados?.turno,
    semDado: Boolean(dados.estados?.dados_sem_dado),
    incoerente: Boolean(dados.estados?.incoerente),
  })
  // Retrato de outro turno: o mapa por município e os cards saem de cena e
  // entra o estado de espera. Desenhar o Brasil colorido com número do turno
  // anterior seria pior do que não desenhar nada.
  const incoerente = Boolean(dados.estados?.incoerente || dados.estados?.dados_sem_dado)
  const intervaloDeCarga =
    apuracao.fase === 'andamento' ? INTERVALO_APURANDO_MS : INTERVALO_PARADO_MS

  useEffect(() => {
    definirMeta({
      titulo: 'Mapa da apuração 2026 — estado, município e local de votação',
      descricao:
        'Mapa interativo da apuração presidencial de 2026: zoom do Brasil até o município e o local de votação, com os números oficiais do TSE.',
    })
  }, [])

  // Carga inicial: estados + malha. A malha vem UMA vez (é geometria, não
  // apuração) e por isso não está no ciclo — o ciclo também NÃO zera o estado:
  // `fase: 'loading'` desmonta o MapWorkspace e é exatamente o que apagaria
  // UF selecionada, replay e zoom.
  const carregarTudo = useCallback(async () => {
    try {
      const [estados, geojson] = await Promise.all([
        fetchJSON(`${API_BASE}/estados`),
        fetchJSON(`${API_BASE}/ufs.geojson`),
      ])
      setDados({ fase: 'ready', estados, geojson, erro: null })
      return true
    } catch (erro) {
      console.error('Falha ao carregar a apuração:', erro)
      setDados((atual) =>
        atual.fase === 'ready' ? atual : { fase: 'error', estados: null, geojson: null, erro },
      )
      return false
    }
  }, [])

  // Ciclo automático: só os DADOS. `/api/ufs.geojson` entra junto porque as
  // cores do mapa saem das propriedades dele (líder e margem por UF) — sem
  // isso o placar do lado atualizaria e o mapa ficaria congelado.
  // `/api/ufs.geojson` são ~257 KB: em 60 s (ou 30 s na apuração) é folgado
  // contra o limite de 40 r/s do nginx.
  const carregarDados = useCallback(async () => {
    try {
      const [estados, geojson] = await Promise.all([
        fetchJSON(`${API_BASE}/estados`),
        fetchJSON(`${API_BASE}/ufs.geojson`),
      ])
      // Troca só o que é dado; `fase` continua 'ready' e nada remonta.
      setDados((atual) =>
        atual.fase === 'ready'
          ? { ...atual, estados, geojson, erro: null }
          : { fase: 'ready', estados, geojson, erro: null },
      )
      setVersao((n) => n + 1)
      return true
    } catch (erro) {
      // Falha de atualização NÃO esvazia a tela: mantém o último dado bom.
      console.error('Falha ao atualizar a apuração:', erro)
      setDados((atual) =>
        atual.fase === 'ready' ? { ...atual, erro } : atual,
      )
      return false
    }
  }, [])

  const atualizacao = useAtualizacaoAutomatica({
    aoCiclar: carregarDados,
    intervaloMs: intervaloDeCarga,
    habilitado: dados.fase === 'ready',
  })
  const registrarLeituraRef = useRef(atualizacao.registrarLeitura)
  const registrarFalhaRef = useRef(atualizacao.registrarFalha)
  registrarLeituraRef.current = atualizacao.registrarLeitura
  registrarFalhaRef.current = atualizacao.registrarFalha

  useEffect(() => {
    let ativo = true
    carregarTudo().then((ok) => {
      if (!ativo) return
      if (ok) registrarLeituraRef.current()
      else registrarFalhaRef.current()
    })
    return () => {
      ativo = false
    }
  }, [carregarTudo, tentativa])

  return (
    <div className="app">
      <BannerAtualizacao
        fase={apuracao.fase}
        pct={apuracao.pct}
        ultimaLeitura={atualizacao.ultimaLeitura}
        falha={atualizacao.falha}
        pausada={atualizacao.pausada}
      />

      <Header estados={dados.estados} erro={dados.erro} aoVivo={aoVivo} />

      {dados.fase === 'loading' ? <StateViews tipo="loading" /> : null}

      {dados.fase === 'error' ? (
        <StateViews
          tipo="error"
          erro={dados.erro}
          onTentarNovamente={() => setTentativa((n) => n + 1)}
        />
      ) : null}

      {dados.fase === 'ready' && incoerente ? (
        <AguardandoTSE
          eleicao={dados.estados?.eleicao}
          turno={dados.estados?.turno}
          variante="mapa"
        />
      ) : null}

      {dados.fase === 'ready' && !incoerente ? (
        <MapWorkspace
          estados={dados.estados}
          geojson={dados.geojson}
          versao={versao}
          ufInicial={atalhos.ufInicial}
          municipioInicial={atalhos.municipioInicial}
          zoomInicial={atalhos.zoomInicial}
          replayInicial={atalhos.replayInicial}
          margemInicial={atalhos.margemInicial}
          onAoVivo={setAoVivo}
        />
      ) : null}

      <Rodape
        variante="mapa"
        eleicao={dados.estados?.eleicao}
        turno={dados.estados ? rotuloTurno(dados.estados.turno) : null}
        geradoEm={incoerente ? null : dados.estados?.gerado_em}
        municipalAviso={incoerente ? null : dados.estados?.municipal?.aviso || null}
        dadosAviso={incoerente ? null : dados.estados?.dados_aviso || null}
      />
    </div>
  )
}
