package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"time"
)

type config struct {
	Eleicao       string
	Turno         string
	DadosDir      string
	Serie2022File string
	Porta         string
	TSEBase       string
	// ApuracaoDemo simula apuração parcial por UF (UF -> % de seções
	// apuradas). Vazio = dados reais. Só existe para provar a exibição da
	// apuração em andamento (barra com segmento de concreto e estado em
	// concreto) sem esperar o dia da eleição. NUNCA ligado em produção.
	ApuracaoDemo map[string]float64
}

func carregarConfig() config {
	dadosDir := envOu("DADOS_DIR", "../dados")
	return config{
		Eleicao:       envOu("ELEICAO", "6257"),
		Turno:         envOu("TURNO", "1"),
		DadosDir:      dadosDir,
		Serie2022File: envOu("SERIE_2022_FILE", filepath.Join(dadosDir, "serie_historica_2022.jsonl")),
		Porta:         envOu("PORT", "8080"),
		TSEBase:       envOu("TSE_BASE", "https://resultados.tse.jus.br/oficial/ele2026"),
		ApuracaoDemo:  lerApuracaoDemo(os.Getenv("APURACAO_DEMO")),
	}
}

// lerApuracaoDemo lê APURACAO_DEMO="CE=78,RR=100" e devolve UF -> percentual
// de seções apuradas simulada. Qualquer par inválido é ignorado, e a UF fora
// da tabela fixa também (a tabela é o único de/para aceito).
func lerApuracaoDemo(bruto string) map[string]float64 {
	bruto = strings.TrimSpace(bruto)
	if bruto == "" {
		return nil
	}

	resultado := make(map[string]float64)
	for _, par := range strings.Split(bruto, ",") {
		partes := strings.Split(strings.TrimSpace(par), "=")
		if len(partes) != 2 {
			continue
		}
		sigla := strings.ToUpper(strings.TrimSpace(partes[0]))
		if !ufValida(sigla) {
			log.Printf("aviso: APURACAO_DEMO ignora UF desconhecida %q", sigla)
			continue
		}
		valor, err := strconv.ParseFloat(strings.TrimSpace(partes[1]), 64)
		if err != nil || math.IsNaN(valor) || math.IsInf(valor, 0) {
			log.Printf("aviso: APURACAO_DEMO ignora percentual inválido em %q", par)
			continue
		}
		if valor < 0 {
			valor = 0
		}
		if valor > 100 {
			valor = 100
		}
		resultado[sigla] = valor
	}
	if len(resultado) == 0 {
		return nil
	}
	log.Printf("APURACAO_DEMO ativo (dados de apuração simulados, não são do TSE): %v", resultado)
	return resultado
}

func envOu(chave, padrao string) string {
	if valor := os.Getenv(chave); valor != "" {
		return valor
	}
	return padrao
}

type ufIBGE struct {
	CodArea string
	Sigla   string
	Nome    string
}

// tabelaUFs é o único de/para entre código IBGE, sigla e nome por extenso.
var tabelaUFs = []ufIBGE{
	{"11", "RO", "Rondônia"},
	{"12", "AC", "Acre"},
	{"13", "AM", "Amazonas"},
	{"14", "RR", "Roraima"},
	{"15", "PA", "Pará"},
	{"16", "AP", "Amapá"},
	{"17", "TO", "Tocantins"},
	{"21", "MA", "Maranhão"},
	{"22", "PI", "Piauí"},
	{"23", "CE", "Ceará"},
	{"24", "RN", "Rio Grande do Norte"},
	{"25", "PB", "Paraíba"},
	{"26", "PE", "Pernambuco"},
	{"27", "AL", "Alagoas"},
	{"28", "SE", "Sergipe"},
	{"29", "BA", "Bahia"},
	{"31", "MG", "Minas Gerais"},
	{"32", "ES", "Espírito Santo"},
	{"33", "RJ", "Rio de Janeiro"},
	{"35", "SP", "São Paulo"},
	{"41", "PR", "Paraná"},
	{"42", "SC", "Santa Catarina"},
	{"43", "RS", "Rio Grande do Sul"},
	{"50", "MS", "Mato Grosso do Sul"},
	{"51", "MT", "Mato Grosso"},
	{"52", "GO", "Goiás"},
	{"53", "DF", "Distrito Federal"},
}

func ufPorCodArea(codArea string) (ufIBGE, bool) {
	for _, uf := range tabelaUFs {
		if uf.CodArea == codArea {
			return uf, true
		}
	}
	return ufIBGE{}, false
}

type candidatoPublico struct {
	Sq      string  `json:"sq"`
	Nome    string  `json:"nome"`
	Partido string  `json:"partido"`
	Votos   int64   `json:"votos"`
	Pct     float64 `json:"pct"`
}

type ufPublico struct {
	UF          string             `json:"uf"`
	Regiao      string             `json:"regiao"`
	PctApurado  float64            `json:"pct_apurado"`
	St          int64              `json:"st"`
	Ts          int64              `json:"ts"`
	VV          int64              `json:"vv"`
	Candidatos  []candidatoPublico `json:"candidatos"`
	Lider       string             `json:"lider"`
	LiderPct    float64            `json:"lider_pct"`
	MargemVotos int64              `json:"margem_votos"`
}

type publico struct {
	GeradoEm string          `json:"gerado_em"`
	Fonte    string          `json:"fonte"`
	Nacional json.RawMessage `json:"nacional"`
	UFs      []ufPublico     `json:"ufs"`
}

type featureEntrada struct {
	Type       string `json:"type"`
	Properties struct {
		CodArea string `json:"codarea"`
	} `json:"properties"`
	Geometry json.RawMessage `json:"geometry"`
}

type malhaEntrada struct {
	Type     string           `json:"type"`
	Features []featureEntrada `json:"features"`
}

type propriedadesUF struct {
	CodArea      string  `json:"codarea"`
	UF           string  `json:"uf"`
	Nome         string  `json:"nome"`
	Regiao       string  `json:"regiao"`
	Lider        string  `json:"lider"`
	LiderPct     float64 `json:"lider_pct"`
	MargemVotos  int64   `json:"margem_votos"`
	MargemPct    float64 `json:"margem_pct"`
	PartidoLider string  `json:"partido_lider"`
	PctApurado   float64 `json:"pct_apurado"`
	VV           int64   `json:"vv"`
	// Seções apuradas / total da UF, lidas do oficial (st/ts). A cor do
	// estado só é liberada quando secoes_apuradas == secoes_total.
	SecoesApuradas int64 `json:"secoes_apuradas"`
	SecoesTotal    int64 `json:"secoes_total"`
}

type featureSaida struct {
	Type       string          `json:"type"`
	Properties propriedadesUF  `json:"properties"`
	Geometry   json.RawMessage `json:"geometry"`
}

type colecaoGeoJSON struct {
	Type     string         `json:"type"`
	Features []featureSaida `json:"features"`
}

type dados struct {
	Publico      *publico
	PublicoBruto json.RawMessage
	Malha        colecaoGeoJSON
	// Curadoria do card de estado (figurinhas emoji + destaques + apelido),
	// servida crua em /api/estados/identidade. Opcional: sem o arquivo a rota
	// devolve {"UF":{}} e o card cai no layout sem figurinha.
	Identidade json.RawMessage
}

func carregarDados(dadosDir string, apuracaoDemo map[string]float64) (*dados, error) {
	caminhoPublico := filepath.Join(dadosDir, "publico.json")
	caminhoMalha := filepath.Join(dadosDir, "malha_uf.geojson")

	conteudoPublico, err := os.ReadFile(caminhoPublico)
	if err != nil {
		return nil, fmt.Errorf("carregar %s: %w", caminhoPublico, err)
	}

	var pub publico
	if err := json.Unmarshal(conteudoPublico, &pub); err != nil {
		return nil, fmt.Errorf("decodificar %s: %w", caminhoPublico, err)
	}

	conteudoMalha, err := os.ReadFile(caminhoMalha)
	if err != nil {
		return nil, fmt.Errorf("carregar %s: %w", caminhoMalha, err)
	}

	var malha malhaEntrada
	if err := json.Unmarshal(conteudoMalha, &malha); err != nil {
		return nil, fmt.Errorf("decodificar %s: %w", caminhoMalha, err)
	}

	ufsPorSigla := make(map[string]ufPublico, len(pub.UFs))
	for _, uf := range pub.UFs {
		ufsPorSigla[uf.UF] = uf
	}

	features := make([]featureSaida, 0, len(malha.Features))
	for _, feature := range malha.Features {
		codArea := feature.Properties.CodArea
		uf, ok := ufPorCodArea(codArea)
		if !ok {
			return nil, fmt.Errorf("malha %s: codarea %q sem UF correspondente na tabela", caminhoMalha, codArea)
		}

		dadosUF, ok := ufsPorSigla[uf.Sigla]
		if !ok {
			return nil, fmt.Errorf("publico %s: UF %s (codarea %s) ausente", caminhoPublico, uf.Sigla, codArea)
		}

		secoesApuradas, secoesTotal, pctApurado := apuracaoDaUF(dadosUF, apuracaoDemo)

		features = append(features, featureSaida{
			Type: feature.Type,
			Properties: propriedadesUF{
				CodArea:        codArea,
				UF:             uf.Sigla,
				Nome:           uf.Nome,
				Regiao:         dadosUF.Regiao,
				Lider:          dadosUF.Lider,
				LiderPct:       dadosUF.LiderPct,
				MargemVotos:    dadosUF.MargemVotos,
				MargemPct:      margemPercentual(dadosUF.MargemVotos, dadosUF.VV),
				PartidoLider:   partidoDoLider(dadosUF),
				PctApurado:     pctApurado,
				VV:             dadosUF.VV,
				SecoesApuradas: secoesApuradas,
				SecoesTotal:    secoesTotal,
			},
			Geometry: feature.Geometry,
		})
	}

	return &dados{
		Publico:      &pub,
		PublicoBruto: json.RawMessage(conteudoPublico),
		Malha: colecaoGeoJSON{
			Type:     "FeatureCollection",
			Features: features,
		},
	}, nil
}

// apuracaoDaUF devolve (seções apuradas, seções totais, pct apurado) da UF.
// A fonte oficial é st/ts do TSE (publico.json) e o percentual NUNCA é
// estimado: é a razão entre os dois. No modo demo (APURACAO_DEMO) o número de
// seções apuradas é reduzido deterministicamente para provar a exibição da
// apuração em andamento, sem tocar nos dados oficiais.
func apuracaoDaUF(uf ufPublico, apuracaoDemo map[string]float64) (int64, int64, float64) {
	total := uf.Ts
	if total <= 0 {
		total = uf.St
	}
	if total < 0 {
		total = 0
	}

	apuradas := uf.St
	if apuradas < 0 {
		apuradas = 0
	}
	if apuradas > total {
		apuradas = total
	}

	if fator, existe := apuracaoDemo[uf.UF]; existe {
		if fator >= 100 {
			apuradas = total
		} else {
			apuradas = int64(math.Floor(float64(total) * fator / 100))
		}
	}

	return apuradas, total, percentual(apuradas, total)
}

func partidoDoLider(uf ufPublico) string {
	for _, candidato := range uf.Candidatos {
		if candidato.Nome == uf.Lider {
			return candidato.Partido
		}
	}
	return ""
}

func margemPercentual(margemVotos, vv int64) float64 {
	if vv == 0 {
		return 0
	}
	return math.Round(float64(margemVotos)/float64(vv)*100*100) / 100
}

type app struct {
	cfg        config
	dados      *dados
	municipais map[string]*dadosUF
}

func novaApp(cfg config) (*app, error) {
	dadosCarregados, err := carregarDados(cfg.DadosDir, cfg.ApuracaoDemo)
	if err != nil {
		return nil, err
	}
	return &app{
		cfg:        cfg,
		dados:      dadosCarregados,
		municipais: carregarDadosMunicipais(cfg.DadosDir, dadosCarregados.Publico, cfg.ApuracaoDemo),
	}, nil
}

func (a *app) handler() http.Handler {
	return withCORS(withLogging(withHead(withRecovery(http.HandlerFunc(a.rotear)))))
}

// rotear concentra as rotas para responder 404 e 405 sempre em JSON.
func (a *app) rotear(w http.ResponseWriter, r *http.Request) {
	var manipulador http.HandlerFunc
	switch r.URL.Path {
	case "/api/health":
		manipulador = a.handleHealth
	case "/api/estados":
		manipulador = a.handleEstados
	case "/api/home":
		manipulador = a.handleHome
	case "/api/serie2022":
		manipulador = a.handleSerie2022
	case "/api/ufs.geojson":
		manipulador = a.handleUfsGeoJSON
	default:
		var reconhecida bool
		manipulador, reconhecida = a.rotaUFDados(r.URL.Path)
		if !reconhecida {
			writeJSON(w, http.StatusNotFound, map[string]string{"erro": "não encontrado"})
			return
		}
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"erro": "método não permitido"})
		return
	}

	manipulador(w, r)
}

// rotaUFDados reconhece apenas /api/uf/{UF}/{recurso}. A UF é comparada com a
// tabela fixa e o restante do caminho precisa casar exatamente; nada do path é
// usado para montar nome de arquivo.
func (a *app) rotaUFDados(caminho string) (http.HandlerFunc, bool) {
	const prefixo = "/api/uf/"
	if !strings.HasPrefix(caminho, prefixo) {
		return nil, false
	}

	resto := strings.TrimPrefix(caminho, prefixo)
	if resto == "" || strings.Contains(resto, "..") || strings.Contains(resto, `\`) {
		return nil, false
	}

	partes := strings.Split(resto, "/")
	if len(partes) != 2 || partes[0] == "" || partes[1] == "" {
		return nil, false
	}

	uf := partes[0]
	if !ufValida(uf) {
		return nil, false
	}

	switch partes[1] {
	case "municipios":
		return a.handleUFMunicipios(uf), true
	case "municipios.geojson":
		return a.handleUFMunicipiosGeoJSON(uf), true
	case "zonas":
		return a.handleUFZonas(uf), true
	case "zonas.geojson":
		return a.handleUFZonasGeoJSON(uf), true
	case "locais":
		return a.handleUFLocais(uf), true
	default:
		return nil, false
	}
}

type healthResposta struct {
	OK       bool   `json:"ok"`
	Eleicao  string `json:"eleicao"`
	Turno    string `json:"turno"`
	GeradoEm string `json:"gerado_em"`
	UFs      int    `json:"ufs"`
	Features int    `json:"features"`
}

func (a *app) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthResposta{
		OK:       true,
		Eleicao:  a.cfg.Eleicao,
		Turno:    a.cfg.Turno,
		GeradoEm: a.dados.Publico.GeradoEm,
		UFs:      len(a.dados.Publico.UFs),
		Features: len(a.dados.Malha.Features),
	})
}

type candidatoResposta struct {
	Nome    string  `json:"nome"`
	Partido string  `json:"partido"`
	Votos   int64   `json:"votos"`
	Pct     float64 `json:"pct"`
}

type ufResposta struct {
	UF          string              `json:"uf"`
	Regiao      string              `json:"regiao"`
	PctApurado  float64             `json:"pct_apurado"`
	St          int64               `json:"st"`
	Ts          int64               `json:"ts"`
	VV          int64               `json:"vv"`
	Lider       string              `json:"lider"`
	LiderPct    float64             `json:"lider_pct"`
	MargemVotos int64               `json:"margem_votos"`
	Candidatos  []candidatoResposta `json:"candidatos"`
}

type estadosResposta struct {
	Eleicao  string          `json:"eleicao"`
	Turno    string          `json:"turno"`
	GeradoEm string          `json:"gerado_em"`
	Fonte    string          `json:"fonte"`
	Nacional json.RawMessage `json:"nacional"`
	UFs      []ufResposta    `json:"ufs"`
}

func (a *app) handleEstados(w http.ResponseWriter, _ *http.Request) {
	ufs := make([]ufResposta, 0, len(a.dados.Publico.UFs))
	for _, uf := range a.dados.Publico.UFs {
		candidatos := make([]candidatoResposta, 0, len(uf.Candidatos))
		for _, candidato := range uf.Candidatos {
			candidatos = append(candidatos, candidatoResposta{
				Nome:    candidato.Nome,
				Partido: candidato.Partido,
				Votos:   candidato.Votos,
				Pct:     candidato.Pct,
			})
		}

		ufs = append(ufs, ufResposta{
			UF:          uf.UF,
			Regiao:      uf.Regiao,
			PctApurado:  uf.PctApurado,
			St:          uf.St,
			Ts:          uf.Ts,
			VV:          uf.VV,
			Lider:       uf.Lider,
			LiderPct:    uf.LiderPct,
			MargemVotos: uf.MargemVotos,
			Candidatos:  candidatos,
		})
	}

	writeJSON(w, http.StatusOK, estadosResposta{
		Eleicao:  a.cfg.Eleicao,
		Turno:    a.cfg.Turno,
		GeradoEm: a.dados.Publico.GeradoEm,
		Fonte:    a.dados.Publico.Fonte,
		Nacional: a.dados.Publico.Nacional,
		UFs:      ufs,
	})
}

func (a *app) handleHome(w http.ResponseWriter, _ *http.Request) {
	eleicao := jsonString(a.cfg.Eleicao)
	turno := jsonString(a.cfg.Turno)

	resposta := make([]byte, 0, len(a.dados.PublicoBruto)+len(eleicao)+len(turno)+32)
	resposta = append(resposta, `{"eleicao":`...)
	resposta = append(resposta, eleicao...)
	resposta = append(resposta, `,"turno":`...)
	resposta = append(resposta, turno...)
	resposta = append(resposta, `,"publico":`...)
	resposta = append(resposta, a.dados.PublicoBruto...)
	resposta = append(resposta, '}', '\n')

	escreverJSONCru(w, http.StatusOK, resposta)
}

const fonteSerie2022 = "TSE - Histórico Totalização Presidente 1º Turno 2022"

// lerSerie2022 devolve apenas objetos JSON válidos, sem repetir o campo "em".
func lerSerie2022(caminho string) ([]json.RawMessage, error) {
	conteudo, err := os.ReadFile(caminho)
	if err != nil {
		return nil, err
	}

	pontos := make([]json.RawMessage, 0)
	vistos := make(map[string]struct{})
	for _, linha := range bytes.Split(conteudo, []byte{'\n'}) {
		linha = bytes.TrimSpace(linha)
		if len(linha) == 0 {
			continue
		}

		var objeto map[string]json.RawMessage
		if err := json.Unmarshal(linha, &objeto); err != nil || objeto == nil {
			continue
		}

		if emCru, temEm := objeto["em"]; temEm {
			var em string
			if err := json.Unmarshal(emCru, &em); err != nil {
				em = string(emCru)
			}
			if _, repetido := vistos[em]; repetido {
				continue
			}
			vistos[em] = struct{}{}
		}

		pontos = append(pontos, json.RawMessage(linha))
	}

	return pontos, nil
}

func (a *app) handleSerie2022(w http.ResponseWriter, _ *http.Request) {
	pontos, err := lerSerie2022(a.cfg.Serie2022File)
	fonte := fonteSerie2022
	if err != nil {
		pontos = nil
		fonte = ""
	}
	if pontos == nil {
		pontos = []json.RawMessage{}
	}

	resposta := make([]byte, 0, 160)
	resposta = append(resposta, `{"eleicao":"2022","fonte":`...)
	resposta = append(resposta, jsonString(fonte)...)
	resposta = append(resposta, `,"total":`...)
	resposta = strconv.AppendInt(resposta, int64(len(pontos)), 10)
	resposta = append(resposta, `,"pontos":[`...)
	for indice, ponto := range pontos {
		if indice > 0 {
			resposta = append(resposta, ',')
		}
		resposta = append(resposta, ponto...)
	}
	resposta = append(resposta, ']', '}', '\n')

	escreverJSONCru(w, http.StatusOK, resposta)
}

func jsonString(valor string) []byte {
	conteudo, err := json.Marshal(valor)
	if err != nil {
		return []byte(`""`)
	}
	return conteudo
}

func (a *app) handleUfsGeoJSON(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.dados.Malha)
}

func writeJSON(w http.ResponseWriter, status int, valor any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(valor); err != nil {
		log.Printf("erro ao codificar resposta JSON: %v", err)
	}
}

// escreverJSONCru grava bytes JSON já montados, preservando o conteúdo original.
func escreverJSONCru(w http.ResponseWriter, status int, conteudo []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if _, err := w.Write(conteudo); err != nil {
		log.Printf("erro ao escrever resposta JSON: %v", err)
	}
}

type registradorStatus struct {
	http.ResponseWriter
	status         int
	escreveuHeader bool
}

func (r *registradorStatus) WriteHeader(status int) {
	if r.escreveuHeader {
		return
	}
	r.status = status
	r.escreveuHeader = true
	r.ResponseWriter.WriteHeader(status)
}

func (r *registradorStatus) Write(conteudo []byte) (int, error) {
	if !r.escreveuHeader {
		r.WriteHeader(http.StatusOK)
	}
	return r.ResponseWriter.Write(conteudo)
}

// escritorHead descarta o corpo, mas conta os bytes para enviar o mesmo
// Content-Length que o GET correspondente teria. O cabeçalho só é repassado
// no fim, quando o tamanho já é conhecido.
type escritorHead struct {
	http.ResponseWriter
	status         int
	escritos       int
	escreveuHeader bool
}

func (e *escritorHead) WriteHeader(status int) {
	if e.escreveuHeader {
		return
	}
	e.status = status
	e.escreveuHeader = true
}

func (e *escritorHead) Write(conteudo []byte) (int, error) {
	if !e.escreveuHeader {
		e.WriteHeader(http.StatusOK)
	}
	e.escritos += len(conteudo)
	return len(conteudo), nil
}

func (e *escritorHead) finalizar() {
	if !e.escreveuHeader {
		e.status = http.StatusOK
	}
	e.Header().Set("Content-Length", strconv.Itoa(e.escritos))
	e.ResponseWriter.WriteHeader(e.status)
}

// withHead trata HEAD como GET, descartando o corpo da resposta.
func withHead(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}

		escritor := &escritorHead{ResponseWriter: w, status: http.StatusOK}
		defer escritor.finalizar()
		next.ServeHTTP(escritor, r)
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
		next.ServeHTTP(w, r)
	})
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inicio := time.Now()
		registrador := &registradorStatus{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(registrador, r)
		log.Printf("%s %s %d %dms", r.Method, r.URL.RequestURI(), registrador.status, time.Since(inicio).Milliseconds())
	})
}

func withRecovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recuperado := recover(); recuperado != nil {
				log.Printf("panic em %s %s: %v\n%s", r.Method, r.URL.Path, recuperado, debug.Stack())
				writeJSON(w, http.StatusInternalServerError, map[string]string{"erro": "erro interno do servidor"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func main() {
	cfg := carregarConfig()
	log.Printf("iniciando api: eleicao=%s turno=%s dados_dir=%s porta=%s", cfg.Eleicao, cfg.Turno, cfg.DadosDir, cfg.Porta)

	aplicacao, err := novaApp(cfg)
	if err != nil {
		log.Fatal(err)
	}

	log.Printf("dados carregados: %d UFs, %d features", len(aplicacao.dados.Publico.UFs), len(aplicacao.dados.Malha.Features))

	servidor := &http.Server{
		Addr:              "0.0.0.0:" + cfg.Porta,
		Handler:           aplicacao.handler(),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      20 * time.Second,
	}

	log.Printf("escutando em %s", servidor.Addr)
	if err := servidor.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
