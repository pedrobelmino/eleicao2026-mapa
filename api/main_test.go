package main

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func novaAppDeTeste(t *testing.T) *app {
	t.Helper()
	t.Setenv("DADOS_DIR", "../dados")

	aplicacao, err := novaApp(carregarConfig())
	if err != nil {
		t.Fatalf("criar aplicação com os dados reais: %v", err)
	}
	return aplicacao
}

func TestHealth(t *testing.T) {
	t.Setenv("ELEICAO", "6257")
	t.Setenv("TURNO", "2")
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}
	if origem := resposta.Header().Get("Access-Control-Allow-Origin"); origem != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, quer %q", origem, "*")
	}
	if contentType := resposta.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Errorf("Content-Type = %q, quer application/json", contentType)
	}

	var corpo struct {
		OK       bool   `json:"ok"`
		Eleicao  string `json:"eleicao"`
		Turno    string `json:"turno"`
		GeradoEm string `json:"gerado_em"`
		UFs      int    `json:"ufs"`
		Features int    `json:"features"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if !corpo.OK {
		t.Error("ok = false, quer true")
	}
	if corpo.Eleicao != "6257" {
		t.Errorf("eleicao = %q, quer %q", corpo.Eleicao, "6257")
	}
	if corpo.Turno != "2" {
		t.Errorf("turno = %q, quer %q", corpo.Turno, "2")
	}
	if corpo.GeradoEm == "" {
		t.Error("gerado_em vazio")
	}
	if corpo.UFs != 27 {
		t.Errorf("ufs = %d, quer 27", corpo.UFs)
	}
	if corpo.Features != 27 {
		t.Errorf("features = %d, quer 27", corpo.Features)
	}
}

func TestHeadHealth(t *testing.T) {
	t.Setenv("ELEICAO", "6257")
	t.Setenv("TURNO", "2")
	aplicacao := novaAppDeTeste(t)

	requisicaoGet := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	respostaGet := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(respostaGet, requisicaoGet)

	requisicao := httptest.NewRequest(http.MethodHead, "/api/health", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}
	if contentType := resposta.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Errorf("Content-Type = %q, quer application/json", contentType)
	}
	if resposta.Body.Len() != 0 {
		t.Errorf("corpo = %q, quer vazio", resposta.Body.String())
	}

	contentLength := resposta.Header().Get("Content-Length")
	esperado := strconv.Itoa(respostaGet.Body.Len())
	if contentLength != esperado {
		t.Errorf("Content-Length = %q, quer %q (tamanho do corpo do GET)", contentLength, esperado)
	}
}

func TestUfsGeoJSON(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/ufs.geojson", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}

	var colecao struct {
		Type     string `json:"type"`
		Features []struct {
			Properties struct {
				CodArea      string  `json:"codarea"`
				UF           string  `json:"uf"`
				Lider        string  `json:"lider"`
				PartidoLider string  `json:"partido_lider"`
				MargemPct    float64 `json:"margem_pct"`
			} `json:"properties"`
			Geometry json.RawMessage `json:"geometry"`
		} `json:"features"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &colecao); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if colecao.Type != "FeatureCollection" {
		t.Errorf("type = %q, quer FeatureCollection", colecao.Type)
	}
	if len(colecao.Features) != 27 {
		t.Fatalf("features = %d, quer 27", len(colecao.Features))
	}

	var encontrada bool
	for _, feature := range colecao.Features {
		if feature.Properties.CodArea != "35" {
			continue
		}
		encontrada = true
		if feature.Properties.UF != "SP" {
			t.Errorf("properties.uf do codarea 35 = %q, quer SP", feature.Properties.UF)
		}
		if feature.Properties.Lider == "" {
			t.Error("properties.lider do codarea 35 vazio")
		}
		if feature.Properties.PartidoLider == "" {
			t.Error("properties.partido_lider do codarea 35 vazio")
		}
		if math.Abs(feature.Properties.MargemPct-13.73) > 0.0001 {
			t.Errorf("properties.margem_pct do codarea 35 = %v, quer 13.73", feature.Properties.MargemPct)
		}
		if len(feature.Geometry) == 0 {
			t.Error("geometry do codarea 35 vazia")
		}
	}
	if !encontrada {
		t.Fatal("feature com codarea 35 não encontrada")
	}
}

func TestEstados(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/estados", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}

	var corpo struct {
		Eleicao  string            `json:"eleicao"`
		Turno    string            `json:"turno"`
		GeradoEm string            `json:"gerado_em"`
		Fonte    string            `json:"fonte"`
		Nacional json.RawMessage   `json:"nacional"`
		UFs      []json.RawMessage `json:"ufs"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if len(corpo.UFs) != 27 {
		t.Errorf("ufs = %d, quer 27", len(corpo.UFs))
	}
	if len(corpo.Nacional) == 0 || string(corpo.Nacional) == "null" {
		t.Error("nacional ausente")
	}
	if corpo.GeradoEm == "" {
		t.Error("gerado_em vazio")
	}
	if corpo.Fonte == "" {
		t.Error("fonte vazia")
	}
	if corpo.Eleicao == "" {
		t.Error("eleicao vazia")
	}
	if corpo.Turno == "" {
		t.Error("turno vazio")
	}
}

func TestHome(t *testing.T) {
	t.Setenv("ELEICAO", "6257")
	t.Setenv("TURNO", "1")
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/home", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}

	var corpo struct {
		Eleicao string          `json:"eleicao"`
		Turno   string          `json:"turno"`
		Publico json.RawMessage `json:"publico"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if corpo.Eleicao != "6257" {
		t.Errorf("eleicao = %q, quer %q", corpo.Eleicao, "6257")
	}
	if corpo.Turno != "1" {
		t.Errorf("turno = %q, quer %q", corpo.Turno, "1")
	}

	var publico map[string]json.RawMessage
	if err := json.Unmarshal(corpo.Publico, &publico); err != nil {
		t.Fatalf("decodificar publico: %v", err)
	}
	nacional, existe := publico["nacional"]
	if !existe {
		t.Fatal("chave nacional ausente em publico")
	}
	if len(nacional) == 0 || string(nacional) == "null" {
		t.Error("nacional vazio em publico")
	}

	conteudoArquivo, err := os.ReadFile("../dados/publico.json")
	if err != nil {
		t.Fatalf("ler publico.json: %v", err)
	}
	if !bytes.Equal(corpo.Publico, conteudoArquivo) {
		t.Error("publico devolvido difere do conteúdo de publico.json")
	}
}

func TestSerie2022(t *testing.T) {
	arquivo := filepath.Join(t.TempDir(), "serie_2022.jsonl")
	conteudo := `{"em":"2022-10-02T17:04:47","pct_apurado":1.5}
{"em":"2022-10-02T17:04:47","pct_apurado":9.9}
{"em":"2022-10-02T17:04:51","pct_apurado":2.5}
`
	if err := os.WriteFile(arquivo, []byte(conteudo), 0o600); err != nil {
		t.Fatalf("criar fixture: %v", err)
	}
	t.Setenv("SERIE_2022_FILE", arquivo)
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/serie2022", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}

	var corpo struct {
		Eleicao string            `json:"eleicao"`
		Fonte   string            `json:"fonte"`
		Total   int               `json:"total"`
		Pontos  []json.RawMessage `json:"pontos"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if corpo.Eleicao != "2022" {
		t.Errorf("eleicao = %q, quer %q", corpo.Eleicao, "2022")
	}
	if corpo.Fonte != fonteSerie2022 {
		t.Errorf("fonte = %q, quer %q", corpo.Fonte, fonteSerie2022)
	}
	if corpo.Total != 2 {
		t.Errorf("total = %d, quer 2", corpo.Total)
	}
	if len(corpo.Pontos) != 2 {
		t.Fatalf("pontos = %d, quer 2", len(corpo.Pontos))
	}

	var pontos []struct {
		Em         string  `json:"em"`
		PctApurado float64 `json:"pct_apurado"`
	}
	for _, ponto := range corpo.Pontos {
		var decodificado struct {
			Em         string  `json:"em"`
			PctApurado float64 `json:"pct_apurado"`
		}
		if err := json.Unmarshal(ponto, &decodificado); err != nil {
			t.Fatalf("decodificar ponto: %v", err)
		}
		pontos = append(pontos, decodificado)
	}
	if pontos[0].Em != "2022-10-02T17:04:47" || pontos[0].PctApurado != 1.5 {
		t.Errorf("primeiro ponto = %+v, quer a primeira ocorrência de 17:04:47", pontos[0])
	}
	if pontos[1].Em != "2022-10-02T17:04:51" || pontos[1].PctApurado != 2.5 {
		t.Errorf("segundo ponto = %+v, quer 17:04:51", pontos[1])
	}
}

func TestSerie2022ArquivoAusente(t *testing.T) {
	arquivo := filepath.Join(t.TempDir(), "serie_ausente.jsonl")
	t.Setenv("SERIE_2022_FILE", arquivo)
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/serie2022", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}

	var corpo struct {
		Eleicao string            `json:"eleicao"`
		Fonte   string            `json:"fonte"`
		Total   int               `json:"total"`
		Pontos  []json.RawMessage `json:"pontos"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if corpo.Eleicao != "2022" {
		t.Errorf("eleicao = %q, quer %q", corpo.Eleicao, "2022")
	}
	if corpo.Fonte != "" {
		t.Errorf("fonte = %q, quer vazia", corpo.Fonte)
	}
	if corpo.Total != 0 {
		t.Errorf("total = %d, quer 0", corpo.Total)
	}
	if len(corpo.Pontos) != 0 {
		t.Errorf("pontos = %d, quer 0", len(corpo.Pontos))
	}
	if !strings.Contains(resposta.Body.String(), `"pontos":[]`) {
		t.Errorf("pontos deveria ser um array vazio: %s", resposta.Body.String())
	}
}

func TestRotaDesconhecida(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/nao-existe", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusNotFound {
		t.Fatalf("status = %d, quer 404", resposta.Code)
	}
	if contentType := resposta.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Errorf("Content-Type = %q, quer application/json", contentType)
	}
	var corpo map[string]string
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if corpo["erro"] != "não encontrado" {
		t.Errorf("erro = %q, quer %q", corpo["erro"], "não encontrado")
	}
}

func TestMetodoPostHome(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodPost, "/api/home", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, quer 405", resposta.Code)
	}
	if contentType := resposta.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Errorf("Content-Type = %q, quer application/json", contentType)
	}
	var corpo map[string]string
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if corpo["erro"] != "método não permitido" {
		t.Errorf("erro = %q, quer %q", corpo["erro"], "método não permitido")
	}
}
