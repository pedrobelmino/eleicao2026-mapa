package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"
)

type config struct {
	Eleicao  string
	Turno    string
	DadosDir string
	Porta    string
	TSEBase  string
}

func carregarConfig() config {
	return config{
		Eleicao:  envOu("ELEICAO", "6257"),
		Turno:    envOu("TURNO", "1"),
		DadosDir: envOu("DADOS_DIR", "../dados"),
		Porta:    envOu("PORT", "8080"),
		TSEBase:  envOu("TSE_BASE", "https://resultados.tse.jus.br/oficial/ele2026"),
	}
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
	Publico *publico
	Malha   colecaoGeoJSON
}

func carregarDados(dadosDir string) (*dados, error) {
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

		features = append(features, featureSaida{
			Type: feature.Type,
			Properties: propriedadesUF{
				CodArea:      codArea,
				UF:           uf.Sigla,
				Nome:         uf.Nome,
				Regiao:       dadosUF.Regiao,
				Lider:        dadosUF.Lider,
				LiderPct:     dadosUF.LiderPct,
				MargemVotos:  dadosUF.MargemVotos,
				MargemPct:    margemPercentual(dadosUF.MargemVotos, dadosUF.VV),
				PartidoLider: partidoDoLider(dadosUF),
				PctApurado:   dadosUF.PctApurado,
				VV:           dadosUF.VV,
			},
			Geometry: feature.Geometry,
		})
	}

	return &dados{
		Publico: &pub,
		Malha: colecaoGeoJSON{
			Type:     "FeatureCollection",
			Features: features,
		},
	}, nil
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
	cfg   config
	dados *dados
}

func novaApp(cfg config) (*app, error) {
	dadosCarregados, err := carregarDados(cfg.DadosDir)
	if err != nil {
		return nil, err
	}
	return &app{cfg: cfg, dados: dadosCarregados}, nil
}

func (a *app) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.handleHealth)
	mux.HandleFunc("GET /api/estados", a.handleEstados)
	mux.HandleFunc("GET /api/ufs.geojson", a.handleUfsGeoJSON)
	mux.HandleFunc("GET /api/municipios.geojson", a.handleMunicipiosGeoJSON)

	return withCORS(withLogging(withRecovery(mux)))
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

func (a *app) handleUfsGeoJSON(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.dados.Malha)
}

func (a *app) handleMunicipiosGeoJSON(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotImplemented, map[string]string{"erro": "não implementado neste item"})
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
