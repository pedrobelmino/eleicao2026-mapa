package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Replay da apuração: o mapa preenche ao longo do tempo, com o relógio e o
// percentual apurado da fonte. Duas fontes, e cada resposta diz o que é dado
// oficial e o que é derivado:
//
//   - modo=2022: a série histórica oficial do TSE (relogio e % apurado reais,
//     ponto a ponto) + o resultado final de 2022 por UF (real). O que NÃO existe
//     em fonte pública é o ritmo de fechamento por UF — esse número é DERIVADO
//     por um modelo de fila declarado (ver filaDeFechamento) e vai rotulado.
//   - modo=2026: os snapshots que o coletor gravou em serie_presidente.jsonl,
//     com st/ts por UF. Tudo real, nenhum número derivado.
//
// Nada é interpolado em silêncio: o campo "derivado" da resposta lista, campo a
// campo, o que não veio do TSE.

type candidatoSerie struct {
	Nome    string  `json:"nome"`
	Partido string  `json:"partido,omitempty"`
	Votos   int64   `json:"votos"`
	Pct     float64 `json:"pct"`
}

// pontoSerie é uma linha de serie_historica_2022.jsonl.
type pontoSerie struct {
	Eleicao    string           `json:"eleicao"`
	Turno      string           `json:"turno"`
	Origem     string           `json:"origem"`
	Fonte      string           `json:"fonte"`
	Em         string           `json:"em"`
	PctApurado float64          `json:"pct_apurado"`
	VV         int64            `json:"vv"`
	Candidatos []candidatoSerie `json:"candidatos"`
}

// uf2022Entrada é o resumo de 2022 por UF (dados/eleicao_2022.json).
type uf2022Entrada struct {
	Secoes       int64   `json:"secoes"`
	V13          int64   `json:"v13"`
	V22          int64   `json:"v22"`
	VOutros      int64   `json:"voutros"`
	Validos      int64   `json:"validos"`
	Lider        string  `json:"lider"`
	PartidoLider string  `json:"partido_lider"`
	LiderPct     float64 `json:"lider_pct"`
	MargemVotos  int64   `json:"margem_votos"`
	MargemPct    float64 `json:"margem_pct"`
}

// municipio2022Entrada é o resumo de 2022 por município (mesma base).
type municipio2022Entrada struct {
	UF           string  `json:"uf"`
	Nome         string  `json:"nome"`
	Secoes       int64   `json:"secoes"`
	V13          int64   `json:"v13"`
	V22          int64   `json:"v22"`
	Validos      int64   `json:"validos"`
	Lider        string  `json:"lider"`
	PartidoLider string  `json:"partido_lider"`
	MargemVotos  int64   `json:"margem_votos"`
	MargemPct    float64 `json:"margem_pct"`
}

type eleicao2022 struct {
	Fonte      string                          `json:"fonte"`
	Arquivo    string                          `json:"arquivo"`
	GeradoEm   string                          `json:"gerado_em"`
	Totais     totais2022                      `json:"totais"`
	UFs        map[string]uf2022Entrada        `json:"ufs"`
	Municipios map[string]municipio2022Entrada `json:"municipios"`
}

type totais2022 struct {
	Secoes  int64 `json:"secoes"`
	V13     int64 `json:"v13"`
	V22     int64 `json:"v22"`
	Validos int64 `json:"validos"`
}

// blocoSnapshot é um bloco nacional ou por UF de serie_presidente.jsonl.
type blocoSnapshot struct {
	ST         int64            `json:"st"`
	TS         int64            `json:"ts"`
	PctApurado float64          `json:"pct_apurado"`
	VV         int64            `json:"vv"`
	Candidatos []candidatoSerie `json:"candidatos"`
}

type snapshot2026 struct {
	ColetadoEm       string                   `json:"coletado_em"`
	FonteGeradaEm    string                   `json:"fonte_gerada_em"`
	FonteGeradaTexto string                   `json:"fonte_gerada_texto"`
	Andamento        string                   `json:"andamento"`
	Nacional         blocoSnapshot            `json:"nacional"`
	UFs              map[string]blocoSnapshot `json:"ufs"`
}

// frameReplay é um instante da apuração. UFs guarda apenas as seções apuradas
// por UF: total, líder e margem ficam em ufs_base, que não muda de frame para
// frame e é enviado uma vez só.
type frameReplay struct {
	Indice         int              `json:"i"`
	Em             string           `json:"em"`
	ColetadoEm     string           `json:"coletado_em,omitempty"`
	PctApurado     float64          `json:"pct_apurado"`
	VV             int64            `json:"vv"`
	Candidatos     []candidatoSerie `json:"candidatos"`
	SecoesApuradas int64            `json:"secoes_apuradas"`
	SecoesTotal    int64            `json:"secoes_total"`
	UFs            map[string]int64 `json:"ufs"`
}

type ufReplayBase struct {
	SecoesTotal  int64   `json:"secoes_total"`
	Lider        string  `json:"lider"`
	PartidoLider string  `json:"partido_lider"`
	LiderPct     float64 `json:"lider_pct"`
	MargemVotos  int64   `json:"margem_votos"`
	MargemPct    float64 `json:"margem_pct"`
}

type replayResposta struct {
	Modo       string                  `json:"modo"`
	Disponivel bool                    `json:"disponivel"`
	Fonte      string                  `json:"fonte"`
	Arquivo    string                  `json:"arquivo"`
	Relogio    string                  `json:"relogio"`
	Resumo     string                  `json:"resumo"`
	Real       []string                `json:"real"`
	Derivado   []string                `json:"derivado"`
	Nota       string                  `json:"nota"`
	Total      int                     `json:"total"`
	UFsBase    map[string]ufReplayBase `json:"ufs_base"`
	Frames     []frameReplay           `json:"frames"`
}

const (
	modoReplay2022 = "2022"
	modoReplay2026 = "2026"
	// modoApuracao é o replay por passo do dump por seção (o padrão de
	// GET /api/replay).
	modoApuracao = "apuracao"
	// Limite de frames: a série de 2022 tem milhares de pontos e o mapa não
	// precisa de todos eles para animar. A amostragem é uniforme e sempre
	// inclui o primeiro e o último ponto reais.
	limiteFramesReplay = 120
)

// lerSeriePontos lê a série JSONL (uma linha = um ponto real do TSE), ignora
// linha inválida e repetição do mesmo "em".
func lerSeriePontos(caminho string) ([]pontoSerie, error) {
	conteudo, err := os.ReadFile(caminho)
	if err != nil {
		return nil, err
	}

	pontos := make([]pontoSerie, 0, 256)
	vistos := make(map[string]struct{})
	for _, linha := range bytes.Split(conteudo, []byte{'\n'}) {
		linha = bytes.TrimSpace(linha)
		if len(linha) == 0 {
			continue
		}
		var ponto pontoSerie
		if err := json.Unmarshal(linha, &ponto); err != nil {
			continue
		}
		if _, repetido := vistos[ponto.Em]; repetido {
			continue
		}
		vistos[ponto.Em] = struct{}{}
		pontos = append(pontos, ponto)
	}
	if len(pontos) == 0 {
		return nil, fmt.Errorf("%s sem pontos válidos", caminho)
	}
	return pontos, nil
}

func lerEleicao2022(caminho string) (*eleicao2022, error) {
	conteudo, err := os.ReadFile(caminho)
	if err != nil {
		return nil, err
	}
	var dados eleicao2022
	if err := json.Unmarshal(conteudo, &dados); err != nil {
		return nil, fmt.Errorf("decodificar %s: %w", caminho, err)
	}
	if len(dados.UFs) == 0 {
		return nil, fmt.Errorf("%s sem a chave \"ufs\"", caminho)
	}
	return &dados, nil
}

func lerSnapshots2026(caminho string) ([]snapshot2026, error) {
	arquivo, err := os.Open(caminho)
	if err != nil {
		return nil, err
	}
	defer arquivo.Close()

	snapshots := make([]snapshot2026, 0, 8)
	leitor := bufio.NewScanner(arquivo)
	leitor.Buffer(make([]byte, 0, 1<<20), 1<<24)
	for leitor.Scan() {
		linha := bytes.TrimSpace(leitor.Bytes())
		if len(linha) == 0 {
			continue
		}
		var snapshot snapshot2026
		if err := json.Unmarshal(linha, &snapshot); err != nil {
			continue
		}
		snapshots = append(snapshots, snapshot)
	}
	if err := leitor.Err(); err != nil {
		return nil, err
	}
	if len(snapshots) == 0 {
		return nil, fmt.Errorf("%s sem snapshots válidos", caminho)
	}
	return snapshots, nil
}

// fila é a posição de uma UF no modelo de fila do replay de 2022: as seções
// entram por UF em ordem crescente de tamanho, então a UF menor fecha primeiro.
// inicio/fim são percentuais da apuração nacional.
type fila struct {
	Sigla  string
	Total  int64
	Inicio float64
	Fim    float64
}

// filaDeFechamento devolve a ordem de fechamento das UFs e o total de seções.
// É um MODELO declarado, não histórico oficial: o TSE publica a série nacional,
// não a série por UF. A ordem é a de tamanho (seções) crescente.
func filaDeFechamento(ufs map[string]uf2022Entrada) ([]fila, int64) {
	siglas := make([]string, 0, len(ufs))
	var total int64
	for sigla, dados := range ufs {
		if dados.Secoes <= 0 {
			continue
		}
		siglas = append(siglas, sigla)
		total += dados.Secoes
	}
	sort.Slice(siglas, func(i, j int) bool {
		if ufs[siglas[i]].Secoes != ufs[siglas[j]].Secoes {
			return ufs[siglas[i]].Secoes < ufs[siglas[j]].Secoes
		}
		return siglas[i] < siglas[j]
	})

	filas := make([]fila, 0, len(siglas))
	var acumulado int64
	for _, sigla := range siglas {
		secoes := ufs[sigla].Secoes
		filas = append(filas, fila{
			Sigla:  sigla,
			Total:  secoes,
			Inicio: 100 * float64(acumulado) / float64(total),
			Fim:    100 * float64(acumulado+secoes) / float64(total),
		})
		acumulado += secoes
	}
	return filas, total
}

// secoesDaFila devolve quantas seções da UF já foram apuradas no percentual
// nacional informado. Interpolação linear DENTRO da faixa da própria UF: o
// valor é derivado (modelo de fila) e nunca aparece sem esse rótulo.
func secoesDaFila(f fila, pctNacional float64) int64 {
	if pctNacional <= 0 {
		return 0
	}
	if pctNacional >= 100 {
		return f.Total
	}
	if pctNacional <= f.Inicio {
		return 0
	}
	fracao := (pctNacional - f.Inicio) / (f.Fim - f.Inicio)
	if fracao >= 1 {
		return f.Total
	}
	apuradas := int64(math.Round(float64(f.Total) * fracao))
	if apuradas < 0 {
		return 0
	}
	if apuradas > f.Total {
		return f.Total
	}
	return apuradas
}

// amostrar devolve até limite índices de uma série, sempre com o primeiro e o
// último ponto reais.
func amostrar(total, limite int) []int {
	if total <= 0 {
		return nil
	}
	if limite <= 1 || total <= limite {
		indices := make([]int, total)
		for i := range indices {
			indices[i] = i
		}
		return indices
	}

	indices := make([]int, 0, limite)
	passo := float64(total-1) / float64(limite-1)
	anterior := -1
	for i := 0; i < limite; i++ {
		indice := int(math.Round(float64(i) * passo))
		if indice >= total {
			indice = total - 1
		}
		if indice == anterior {
			continue
		}
		indices = append(indices, indice)
		anterior = indice
	}
	if indices[len(indices)-1] != total-1 {
		indices = append(indices, total-1)
	}
	return indices
}

// framesReplay2022 monta os frames a partir da série nacional real e do
// resultado final de 2022 por UF.
func framesReplay2022(serie []pontoSerie, dados *eleicao2022) ([]frameReplay, map[string]ufReplayBase) {
	filas, total := filaDeFechamento(dados.UFs)

	base := make(map[string]ufReplayBase, len(dados.UFs))
	for sigla, uf := range dados.UFs {
		base[sigla] = ufReplayBase{
			SecoesTotal:  uf.Secoes,
			Lider:        uf.Lider,
			PartidoLider: uf.PartidoLider,
			LiderPct:     uf.LiderPct,
			MargemVotos:  uf.MargemVotos,
			MargemPct:    uf.MargemPct,
		}
	}

	indices := amostrar(len(serie), limiteFramesReplay)
	frames := make([]frameReplay, 0, len(indices))
	for numero, indice := range indices {
		ponto := serie[indice]
		porUF := make(map[string]int64, len(filas))
		var somadas int64
		for _, item := range filas {
			apuradas := secoesDaFila(item, ponto.PctApurado)
			porUF[item.Sigla] = apuradas
			somadas += apuradas
		}
		frames = append(frames, frameReplay{
			Indice:         numero,
			Em:             ponto.Em,
			PctApurado:     ponto.PctApurado,
			VV:             ponto.VV,
			Candidatos:     ponto.Candidatos,
			SecoesApuradas: somadas,
			SecoesTotal:    total,
			UFs:            porUF,
		})
	}
	return frames, base
}

// framesReplay2026 monta os frames com os snapshots reais do coletor. Snapshot
// repetido (mesma contagem de seções) é descartado: no dia da eleição cada
// coleta nova vira um frame, e uma coleta que não mudou nada não vira nada.
func framesReplay2026(snapshots []snapshot2026) ([]frameReplay, map[string]ufReplayBase) {
	base := make(map[string]ufReplayBase, len(snapshots[0].UFs))
	frames := make([]frameReplay, 0, len(snapshots))
	anterior := ""

	for _, snapshot := range snapshots {
		assinatura := fmt.Sprintf("%s|%d|%d", snapshot.Andamento, snapshot.Nacional.ST, snapshot.Nacional.TS)
		for sigla, bloco := range snapshot.UFs {
			assinatura += fmt.Sprintf("|%s:%d", sigla, bloco.ST)
		}
		if assinatura == anterior {
			continue
		}
		anterior = assinatura

		porUF := make(map[string]int64, len(snapshot.UFs))
		var somadas, total int64
		for sigla, bloco := range snapshot.UFs {
			porUF[sigla] = bloco.ST
			somadas += bloco.ST
			total += bloco.TS
		}

		em := snapshot.FonteGeradaEm
		if em == "" {
			em = snapshot.ColetadoEm
		}

		frames = append(frames, frameReplay{
			Indice:         len(frames),
			Em:             em,
			ColetadoEm:     snapshot.ColetadoEm,
			PctApurado:     snapshot.Nacional.PctApurado,
			VV:             snapshot.Nacional.VV,
			Candidatos:     snapshot.Nacional.Candidatos,
			SecoesApuradas: somadas,
			SecoesTotal:    total,
			UFs:            porUF,
		})
	}

	// A base (total de seções, líder e margem por UF) sai do snapshot mais
	// completo — o último coletado.
	ultimo := snapshots[len(snapshots)-1]
	for sigla, bloco := range ultimo.UFs {
		lider, partido, pct, margem := liderDoBloco(bloco)
		base[sigla] = ufReplayBase{
			SecoesTotal:  bloco.TS,
			Lider:        lider,
			PartidoLider: partido,
			LiderPct:     pct,
			MargemVotos:  margem,
			MargemPct:    margemPercentual(margem, bloco.VV),
		}
	}
	return frames, base
}

// liderDoBloco devolve líder, partido, percentual e margem em votos de um bloco
// por UF. A ordem dos candidatos no arquivo não é premissa: o maior leva.
func liderDoBloco(bloco blocoSnapshot) (string, string, float64, int64) {
	if len(bloco.Candidatos) == 0 {
		return "", "", 0, 0
	}
	ordenados := make([]candidatoSerie, len(bloco.Candidatos))
	copy(ordenados, bloco.Candidatos)
	sort.SliceStable(ordenados, func(i, j int) bool {
		return ordenados[i].Votos > ordenados[j].Votos
	})
	primeiro := ordenados[0]
	var margem int64
	if len(ordenados) > 1 {
		margem = primeiro.Votos - ordenados[1].Votos
	}
	return primeiro.Nome, primeiro.Partido, primeiro.Pct, margem
}

func (a *app) handleReplay(w http.ResponseWriter, r *http.Request) {
	modo := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("modo")))
	// Sem modo, GET /api/replay devolve a série de apuração de 2026 por passo
	// (dump do TSE por seção). `modo=2022` e `modo=2026` continuam sendo os
	// replays de frames, para as provas antigas e para o histórico.
	if modo == "" || modo == modoApuracao {
		a.handleApuracaoReplay(w)
		return
	}

	switch modo {
	case modoReplay2022:
		a.replay2022(w)
	case modoReplay2026:
		a.replay2026(w)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"erro": "modo inválido: use apuracao, 2022 ou 2026",
		})
	}
}

func (a *app) replay2022(w http.ResponseWriter) {
	resposta := replayResposta{
		Modo:    modoReplay2022,
		Fonte:   fonteSerie2022,
		Arquivo: "dados/serie_historica_2022.jsonl",
		Relogio: "em (data/hora de cada ponto do arquivo histórico do TSE)",
		UFsBase: map[string]ufReplayBase{},
		Frames:  []frameReplay{},
		Real: []string{
			"relógio (em)",
			"% apurado nacional",
			"votos de cada candidato por ponto",
			"total de seções por UF",
			"líder, partido e margem por UF (resultado final de 2022)",
		},
		Derivado: []string{
			"seções apuradas por UF em cada instante (modelo de fila)",
		},
		Nota: "Relógio, % apurado e votos vêm do arquivo histórico do TSE. " +
			"O TSE não publica a série por UF: o ritmo de fechamento de cada UF é " +
			"derivado por um modelo de fila (UFs menores fecham primeiro) e está " +
			"marcado como DERIVADO na tela.",
	}

	if len(a.serie2022) == 0 || a.eleicao2022 == nil {
		resposta.Nota = "série histórica de 2022 indisponível nesta instalação"
		writeJSON(w, http.StatusOK, resposta)
		return
	}

	frames, base := framesReplay2022(a.serie2022, a.eleicao2022)
	resposta.Disponivel = true
	resposta.Total = len(frames)
	resposta.Frames = frames
	resposta.UFsBase = base
	primeiro := a.serie2022[0]
	ultimo := a.serie2022[len(a.serie2022)-1]
	resposta.Resumo = fmt.Sprintf(
		"%d pontos reais do TSE, de %s a %s (%s a %s do 1º turno de 2022); %d frames no replay",
		len(a.serie2022), primeiro.Em, ultimo.Em, pontoTexto(primeiro), pontoTexto(ultimo), len(frames),
	)
	writeJSON(w, http.StatusOK, resposta)
}

func pontoTexto(ponto pontoSerie) string {
	return fmt.Sprintf("%.2f%% apurado", ponto.PctApurado)
}

func (a *app) replay2026(w http.ResponseWriter) {
	resposta := replayResposta{
		Modo:    modoReplay2026,
		Fonte:   "Coletas do painel (TSE, eleição 6257)",
		Arquivo: "dados/serie_presidente_2026.jsonl",
		Relogio: "fonte_gerada_em (hora do arquivo do TSE em cada coleta)",
		UFsBase: map[string]ufReplayBase{},
		Frames:  []frameReplay{},
		Real: []string{
			"relógio (arquivo do TSE)",
			"seções apuradas por UF",
			"% apurado",
			"votos de cada candidato",
		},
		Derivado: []string{},
		Nota: "Cada frame é uma coleta real do painel, sem interpolação. " +
			"Enquanto o TSE não publicar parciais, o replay tem apenas o começo e o fim.",
	}

	if len(a.snapshots2026) == 0 {
		resposta.Nota = "nenhuma coleta de 2026 disponível nesta instalação"
		writeJSON(w, http.StatusOK, resposta)
		return
	}

	frames, base := framesReplay2026(a.snapshots2026)
	resposta.Disponivel = true
	resposta.Total = len(frames)
	resposta.Frames = frames
	resposta.UFsBase = base
	primeiro := a.snapshots2026[0]
	ultimo := a.snapshots2026[len(a.snapshots2026)-1]
	resposta.Resumo = fmt.Sprintf(
		"%d coletas reais (%d frames após descartar repetição), de %s a %s",
		len(a.snapshots2026), len(frames), primeiro.ColetadoEm, ultimo.ColetadoEm,
	)
	writeJSON(w, http.StatusOK, resposta)
}

// carregarReplay carrega as duas fontes do replay no boot. Falha em uma delas
// não derruba a API: a resposta daquela fonte sai com disponivel=false e a nota
// explica o motivo.
func carregarReplay(cfg config) ([]pontoSerie, *eleicao2022, []snapshot2026) {
	var serie []pontoSerie
	if pontos, err := lerSeriePontos(cfg.Serie2022File); err != nil {
		log.Printf("aviso: série de 2022 indisponível (%v); replay de 2022 desativado", err)
	} else {
		serie = pontos
		log.Printf("replay 2022: %d pontos reais de %s", len(pontos), filepath.Base(cfg.Serie2022File))
	}

	var dados2022 *eleicao2022
	if carregado, err := lerEleicao2022(cfg.Eleicao2022File); err != nil {
		log.Printf("aviso: resultado de 2022 por UF indisponível (%v); replay de 2022 desativado", err)
	} else {
		dados2022 = carregado
		log.Printf("resultado de 2022: %d UFs, %d municípios", len(carregado.UFs), len(carregado.Municipios))
	}

	var snapshots []snapshot2026
	if coletados, err := lerSnapshots2026(cfg.Serie2026File); err != nil {
		log.Printf("aviso: coletas de 2026 indisponíveis (%v); replay de 2026 desativado", err)
	} else {
		snapshots = coletados
		log.Printf("replay 2026: %d coletas reais", len(coletados))
	}

	return serie, dados2022, snapshots
}
