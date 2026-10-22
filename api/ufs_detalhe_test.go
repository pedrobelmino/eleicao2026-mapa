package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestUFMunicipios(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/uf/CE/municipios", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200: %s", resposta.Code, resposta.Body.String())
	}

	var corpo struct {
		UF              string `json:"uf"`
		Eleicao         string `json:"eleicao"`
		Turno           string `json:"turno"`
		TotalMunicipios int    `json:"total_municipios"`
		Totais          struct {
			Total   int64 `json:"total"`
			Validos int64 `json:"validos"`
			Brancos int64 `json:"brancos"`
			Nulos   int64 `json:"nulos"`
			Secoes  int64 `json:"secoes"`
		} `json:"totais"`
		Municipios []struct {
			CodIBGE int64 `json:"cd_ibge"`
			CodTSE  int64 `json:"cd_tse"`
			Total   int64 `json:"total"`
			Secoes  int64 `json:"secoes"`
		} `json:"municipios"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}

	if corpo.UF != "CE" {
		t.Errorf("uf = %q, quer CE", corpo.UF)
	}
	if corpo.Eleicao == "" || corpo.Turno == "" {
		t.Errorf("eleicao/turno vazios: %q/%q", corpo.Eleicao, corpo.Turno)
	}
	if corpo.TotalMunicipios != 184 {
		t.Errorf("total_municipios = %d, quer 184", corpo.TotalMunicipios)
	}
	if len(corpo.Municipios) != 184 {
		t.Errorf("municipios = %d, quer 184", len(corpo.Municipios))
	}

	var somaTotal, somaSecoes int64
	for _, municipio := range corpo.Municipios {
		somaTotal += municipio.Total
		somaSecoes += municipio.Secoes
	}
	if somaTotal != 5910471 {
		t.Errorf("soma dos totais = %d, quer 5910471", somaTotal)
	}
	if somaSecoes != 23765 {
		t.Errorf("soma das seções = %d, quer 23765", somaSecoes)
	}
	if corpo.Totais.Total != 5910471 {
		t.Errorf("totais.total = %d, quer 5910471", corpo.Totais.Total)
	}
	if corpo.Totais.Secoes != 23765 {
		t.Errorf("totais.secoes = %d, quer 23765", corpo.Totais.Secoes)
	}
}

func TestUFZonas(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/uf/CE/zonas", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200: %s", resposta.Code, resposta.Body.String())
	}

	var corpo struct {
		UF         string `json:"uf"`
		TotalZonas int    `json:"total_zonas"`
		Totais     struct {
			Total  int64 `json:"total"`
			Secoes int64 `json:"secoes"`
		} `json:"totais"`
		Zonas []struct {
			Zona    int64   `json:"zona"`
			CodTSE  int64   `json:"cd_tse"`
			Lat     float64 `json:"lat"`
			Lon     float64 `json:"lon"`
			Total   int64   `json:"total"`
			Secoes  int64   `json:"secoes"`
			AlturaM float64 `json:"altura_m"`
			RaioM   float64 `json:"raio_m"`
		} `json:"zonas"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}

	if corpo.TotalZonas != 205 {
		t.Errorf("total_zonas = %d, quer 205", corpo.TotalZonas)
	}
	if len(corpo.Zonas) != 205 {
		t.Errorf("zonas = %d, quer 205", len(corpo.Zonas))
	}

	var somaTotal, somaSecoes int64
	for _, zona := range corpo.Zonas {
		somaTotal += zona.Total
		somaSecoes += zona.Secoes

		if math.IsNaN(zona.Lat) || math.IsInf(zona.Lat, 0) || math.IsNaN(zona.Lon) || math.IsInf(zona.Lon, 0) {
			t.Errorf("zona %d-%d com lat/lon não finitos: %v/%v", zona.CodTSE, zona.Zona, zona.Lat, zona.Lon)
		}
		if zona.AlturaM <= 0 {
			t.Errorf("zona %d-%d com altura_m = %v, quer > 0", zona.CodTSE, zona.Zona, zona.AlturaM)
		}
		if zona.RaioM <= 0 {
			t.Errorf("zona %d-%d com raio_m = %v, quer > 0", zona.CodTSE, zona.Zona, zona.RaioM)
		}
	}
	if somaTotal != 5910471 {
		t.Errorf("soma dos totais das zonas = %d, quer 5910471", somaTotal)
	}
	if somaSecoes != 23765 {
		t.Errorf("soma das seções das zonas = %d, quer 23765", somaSecoes)
	}
	if corpo.Totais.Total != 5910471 {
		t.Errorf("totais.total = %d, quer 5910471", corpo.Totais.Total)
	}
}

func TestUFMunicipiosGeoJSON(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/uf/CE/municipios.geojson", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200: %s", resposta.Code, resposta.Body.String())
	}
	if contentType := resposta.Header().Get("Content-Type"); contentType != "application/geo+json" {
		t.Errorf("Content-Type = %q, quer application/geo+json", contentType)
	}

	var colecao struct {
		Type     string `json:"type"`
		Features []struct {
			ID         string `json:"id"`
			Properties struct {
				CodArea      string `json:"codarea"`
				PartidoLider string `json:"partido_lider"`
				Lider        string `json:"lider"`
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
	if len(colecao.Features) != 184 {
		t.Fatalf("features = %d, quer 184", len(colecao.Features))
	}

	vistos := make(map[string]bool, len(colecao.Features))
	for _, feature := range colecao.Features {
		if len(feature.ID) != 7 {
			t.Errorf("id = %q, quer 7 dígitos", feature.ID)
		}
		for _, digito := range feature.ID {
			if digito < '0' || digito > '9' {
				t.Errorf("id = %q não é numérico", feature.ID)
				break
			}
		}
		if vistos[feature.ID] {
			t.Errorf("id repetido: %q", feature.ID)
		}
		vistos[feature.ID] = true

		if feature.Properties.PartidoLider == "" {
			t.Errorf("feature %s sem partido_lider", feature.ID)
		}
		if feature.Properties.Lider == "" {
			t.Errorf("feature %s sem lider", feature.ID)
		}
		if len(feature.Geometry) == 0 {
			t.Errorf("feature %s sem geometria", feature.ID)
		}
	}
}

func TestUFZonasGeoJSON(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/uf/CE/zonas.geojson", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200: %s", resposta.Code, resposta.Body.String())
	}
	if contentType := resposta.Header().Get("Content-Type"); contentType != "application/geo+json" {
		t.Errorf("Content-Type = %q, quer application/geo+json", contentType)
	}

	var colecao struct {
		Type     string `json:"type"`
		Features []struct {
			ID         string `json:"id"`
			Properties struct {
				Zona    int64   `json:"zona"`
				CodTSE  int64   `json:"cd_tse"`
				AlturaM float64 `json:"altura_m"`
			} `json:"properties"`
			Geometry struct {
				Type        string         `json:"type"`
				Coordinates [][][2]float64 `json:"coordinates"`
			} `json:"geometry"`
		} `json:"features"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &colecao); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}

	if colecao.Type != "FeatureCollection" {
		t.Errorf("type = %q, quer FeatureCollection", colecao.Type)
	}
	if len(colecao.Features) != 205 {
		t.Fatalf("features = %d, quer 205", len(colecao.Features))
	}

	for _, feature := range colecao.Features {
		if feature.Geometry.Type != "Polygon" {
			t.Errorf("feature %s: geometry.type = %q, quer Polygon", feature.ID, feature.Geometry.Type)
			continue
		}
		if len(feature.Geometry.Coordinates) != 1 {
			t.Errorf("feature %s: anéis = %d, quer 1", feature.ID, len(feature.Geometry.Coordinates))
			continue
		}
		anel := feature.Geometry.Coordinates[0]
		if len(anel) != 7 {
			t.Errorf("feature %s: pontos = %d, quer 7", feature.ID, len(anel))
			continue
		}
		if anel[0] != anel[len(anel)-1] {
			t.Errorf("feature %s: primeiro ponto %v difere do último %v", feature.ID, anel[0], anel[len(anel)-1])
		}
		if feature.Properties.AlturaM <= 0 {
			t.Errorf("feature %s: altura_m = %v, quer > 0", feature.ID, feature.Properties.AlturaM)
		}
	}
}

func TestUFRotasNaoEncontradas(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	casos := []string{
		"/api/uf/XX/municipios",
		"/api/uf/ce/municipios",
		"/api/uf/CE/municipios/../../etc/passwd",
		"/api/uf/CE/qualquercoisa",
		"/api/uf/CE/%2e%2e/municipios",
		"/api/uf//CE/municipios",
		"/api/uf/CE/municipios/",
	}
	for _, caminho := range casos {
		caminho := caminho
		t.Run(caminho, func(t *testing.T) {
			requisicao := httptest.NewRequest(http.MethodGet, caminho, nil)
			resposta := httptest.NewRecorder()
			aplicacao.handler().ServeHTTP(resposta, requisicao)

			if resposta.Code != http.StatusNotFound {
				t.Fatalf("status = %d, quer 404 (%s)", resposta.Code, resposta.Body.String())
			}
			var corpo map[string]string
			if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
				t.Fatalf("decodificar resposta: %v", err)
			}
			if corpo["erro"] != "não encontrado" {
				t.Errorf("erro = %q, quer %q", corpo["erro"], "não encontrado")
			}
		})
	}
}

func TestUFSemDadosMunicipais(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/uf/SP/municipios", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusNotFound {
		t.Fatalf("status = %d, quer 404", resposta.Code)
	}
	var corpo map[string]string
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if corpo["erro"] != "sem dados municipais para esta UF" {
		t.Errorf("erro = %q, quer %q", corpo["erro"], "sem dados municipais para esta UF")
	}
}

func TestUFZonasMetodoPost(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodPost, "/api/uf/CE/zonas", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, quer 405", resposta.Code)
	}
	var corpo map[string]string
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if corpo["erro"] != "método não permitido" {
		t.Errorf("erro = %q, quer %q", corpo["erro"], "método não permitido")
	}
}

func TestRotaMunicipiosAntiga(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/municipios.geojson", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusNotFound {
		t.Fatalf("status = %d, quer 404", resposta.Code)
	}
}

type secaoLocalTeste struct {
	Zona       int64   `json:"zona"`
	Secao      int64   `json:"secao"`
	Lat        float64 `json:"lat"`
	Lon        float64 `json:"lon"`
	Total      int64   `json:"total"`
	VV         int64   `json:"vv"`
	V13        int64   `json:"v13"`
	V22        int64   `json:"v22"`
	VOutros    int64   `json:"voutros"`
	Lider      string  `json:"lider"`
	PctApurado float64 `json:"pct_apurado"`
}

type localTeste struct {
	NrLocal         int64             `json:"nr_local"`
	Lat             float64           `json:"lat"`
	Lon             float64           `json:"lon"`
	Total           int64             `json:"total"`
	VV              int64             `json:"vv"`
	V13             int64             `json:"v13"`
	V22             int64             `json:"v22"`
	VOutros         int64             `json:"voutros"`
	Lider           string            `json:"lider"`
	LiderCod        string            `json:"lider_cod"`
	PartidoLider    string            `json:"partido_lider"`
	LiderPct        float64           `json:"lider_pct"`
	MargemVotos     int64             `json:"margem_votos"`
	MargemPct       float64           `json:"margem_pct"`
	PctApurado      float64           `json:"pct_apurado"`
	SecoesApuradas  int               `json:"secoes_apuradas"`
	SecoesEsperadas int               `json:"secoes_esperadas"`
	Agrupado        bool              `json:"agrupado"`
	NrLocais        []int64           `json:"nr_locais"`
	Secoes          []secaoLocalTeste `json:"secoes"`
}

type locaisTeste struct {
	UF          string `json:"uf"`
	CD          int64  `json:"cd"`
	Municipio   string `json:"municipio"`
	TotalLocais int    `json:"total_locais"`
	Totais      struct {
		Total  int64 `json:"total"`
		VV     int64 `json:"vv"`
		Secoes int64 `json:"secoes"`
	} `json:"totais"`
	Locais []localTeste `json:"locais"`
}

func obterLocaisMunicipio(t *testing.T, cd int64) locaisTeste {
	t.Helper()
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/uf/CE/locais?cd=%d", cd), nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200: %s", resposta.Code, resposta.Body.String())
	}

	var corpo locaisTeste
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	return corpo
}

func obterLocaisFortaleza(t *testing.T) locaisTeste {
	t.Helper()
	return obterLocaisMunicipio(t, 13897)
}

// carregarSecoesCETeste lê o dump bruto para comparar o antes (seções) com o
// depois (locais já agrupados por coordenada).
func carregarSecoesCETeste(t *testing.T) (secoesArquivo, map[string]int) {
	t.Helper()
	conteudo, err := os.ReadFile("../dados/secoes_CE.json")
	if err != nil {
		t.Fatalf("ler secoes_CE.json: %v", err)
	}
	var arquivo secoesArquivo
	if err := json.Unmarshal(conteudo, &arquivo); err != nil {
		t.Fatalf("decodificar secoes_CE.json: %v", err)
	}
	indice := make(map[string]int, len(arquivo.Campos))
	for posicao, nome := range arquivo.Campos {
		indice[nome] = posicao
	}
	return arquivo, indice
}

func TestUFLocaisFortaleza(t *testing.T) {
	corpo := obterLocaisFortaleza(t)

	if corpo.UF != "CE" {
		t.Errorf("uf = %q, quer CE", corpo.UF)
	}
	if corpo.CD != 13897 {
		t.Errorf("cd = %d, quer 13897", corpo.CD)
	}
	if corpo.Municipio != "FORTALEZA" {
		t.Errorf("municipio = %q, quer FORTALEZA", corpo.Municipio)
	}
	if corpo.TotalLocais != 196 {
		t.Errorf("total_locais = %d, quer 196", corpo.TotalLocais)
	}
	if len(corpo.Locais) != 196 {
		t.Errorf("locais = %d, quer 196", len(corpo.Locais))
	}
	if corpo.Totais.Secoes != 5335 {
		t.Errorf("totais.secoes = %d, quer 5335", corpo.Totais.Secoes)
	}
	if corpo.Totais.Total != 1561854 {
		t.Errorf("totais.total = %d, quer 1561854", corpo.Totais.Total)
	}

	var somaTotal, somaVV, somaSecoes int64
	for _, local := range corpo.Locais {
		if local.VV != local.V13+local.V22+local.VOutros {
			t.Errorf("local %d: vv = %d, quer %d", local.NrLocal, local.VV, local.V13+local.V22+local.VOutros)
		}
		if math.IsNaN(local.Lat) || math.IsInf(local.Lat, 0) || math.IsNaN(local.Lon) || math.IsInf(local.Lon, 0) {
			t.Errorf("local %d: lat/lon não finitos: %v/%v", local.NrLocal, local.Lat, local.Lon)
		}
		somaTotal += local.Total
		somaVV += local.VV
		somaSecoes += int64(len(local.Secoes))
	}
	if somaTotal != corpo.Totais.Total {
		t.Errorf("soma dos totais dos locais = %d, quer totais.total = %d", somaTotal, corpo.Totais.Total)
	}
	if somaVV != corpo.Totais.VV {
		t.Errorf("soma dos vv dos locais = %d, quer totais.vv = %d", somaVV, corpo.Totais.VV)
	}
	if somaSecoes != corpo.Totais.Secoes {
		t.Errorf("soma das seções dos locais = %d, quer totais.secoes = %d", somaSecoes, corpo.Totais.Secoes)
	}
}

func TestUFLocal1112(t *testing.T) {
	corpo := obterLocaisFortaleza(t)

	var encontrado *localTeste
	for indice := range corpo.Locais {
		if corpo.Locais[indice].NrLocal == 1112 {
			encontrado = &corpo.Locais[indice]
			break
		}
	}
	if encontrado == nil {
		t.Fatal("local 1112 não encontrado em Fortaleza")
	}
	if encontrado.Total != 19765 {
		t.Errorf("local 1112: total = %d, quer 19765", encontrado.Total)
	}
	if len(encontrado.Secoes) != 61 {
		t.Errorf("local 1112: seções = %d, quer 61", len(encontrado.Secoes))
	}

	for indice := 1; indice < len(encontrado.Secoes); indice++ {
		anterior := encontrado.Secoes[indice-1]
		atual := encontrado.Secoes[indice]
		if atual.Zona < anterior.Zona || (atual.Zona == anterior.Zona && atual.Secao < anterior.Secao) {
			t.Errorf("seções fora de ordem: (%d,%d) antes de (%d,%d)",
				anterior.Zona, anterior.Secao, atual.Zona, atual.Secao)
		}
	}
}

func TestUFLocaisSomaSecoes(t *testing.T) {
	corpo := obterLocaisFortaleza(t)

	for _, local := range corpo.Locais {
		var somaTotal int64
		for _, secao := range local.Secoes {
			somaTotal += secao.Total
			if secao.VV != secao.V13+secao.V22+secao.VOutros {
				t.Errorf("local %d seção (%d,%d): vv = %d, quer %d",
					local.NrLocal, secao.Zona, secao.Secao, secao.VV, secao.V13+secao.V22+secao.VOutros)
			}
		}
		if somaTotal != local.Total {
			t.Errorf("local %d: soma das seções = %d, quer total = %d", local.NrLocal, somaTotal, local.Total)
		}
	}
}

func TestUFLocaisParametros(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	casos := []struct {
		nome    string
		metodo  string
		caminho string
		status  int
		erro    string
	}{
		{"sem cd", http.MethodGet, "/api/uf/CE/locais", http.StatusBadRequest, "parâmetro cd obrigatório"},
		{"cd texto", http.MethodGet, "/api/uf/CE/locais?cd=abc", http.StatusBadRequest, "parâmetro cd obrigatório"},
		{"cd inexistente", http.MethodGet, "/api/uf/CE/locais?cd=999999", http.StatusNotFound, "sem locais para este município"},
		{"uf sem dados", http.MethodGet, "/api/uf/SP/locais?cd=1", http.StatusNotFound, "sem dados municipais para esta UF"},
		{"metodo post", http.MethodPost, "/api/uf/CE/locais?cd=13897", http.StatusMethodNotAllowed, "método não permitido"},
	}
	for _, caso := range casos {
		caso := caso
		t.Run(caso.nome, func(t *testing.T) {
			requisicao := httptest.NewRequest(caso.metodo, caso.caminho, nil)
			resposta := httptest.NewRecorder()
			aplicacao.handler().ServeHTTP(resposta, requisicao)

			if resposta.Code != caso.status {
				t.Fatalf("status = %d, quer %d (%s)", resposta.Code, caso.status, resposta.Body.String())
			}
			var corpo map[string]string
			if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
				t.Fatalf("decodificar resposta: %v", err)
			}
			if corpo["erro"] != caso.erro {
				t.Errorf("erro = %q, quer %q", corpo["erro"], caso.erro)
			}
		})
	}
}
