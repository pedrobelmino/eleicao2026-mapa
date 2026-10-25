package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestIncoerenciaDeTurno cobre o defeito que o painel exibiu na virada: painel
// no 2º turno (ELEICAO 6258) com publico.json do 1º turno (ELEICAO 6257) no
// disco. Nesse estado NADA pode sair com número: as três rotas de dado têm de
// responder zerado, e o health/config têm de dizer `incoerente: true` com a
// procedência do arquivo.
func TestIncoerenciaDeTurno(t *testing.T) {
	t.Setenv("ELEICAO", "6258")
	t.Setenv("TURNO", "2")
	aplicacao := novaAppDeTeste(t)

	pegar := func(caminho string) []byte {
		t.Helper()
		requisicao := httptest.NewRequest(http.MethodGet, caminho, nil)
		resposta := httptest.NewRecorder()
		aplicacao.handler().ServeHTTP(resposta, requisicao)
		if resposta.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, quer 200", caminho, resposta.Code)
		}
		return resposta.Body.Bytes()
	}

	health := struct {
		Turno         string `json:"turno"`
		UFs           int    `json:"ufs"`
		Incoerente    bool   `json:"incoerente"`
		DadosEleicao  string `json:"dados_eleicao"`
		DadosTurno    string `json:"dados_turno"`
		DadosGeradoEm string `json:"dados_gerado_em"`
		DadosAviso    string `json:"dados_aviso"`
	}{}
	if err := json.Unmarshal(pegar("/api/health"), &health); err != nil {
		t.Fatalf("health: %v", err)
	}
	if !health.Incoerente {
		t.Error("health.incoerente = false, quer true (painel 6258, arquivo 6257)")
	}
	if health.Turno != "2" {
		t.Errorf("health.turno = %q, quer %q (turno do painel)", health.Turno, "2")
	}
	if health.DadosEleicao != "6257" || health.DadosTurno == "" {
		t.Errorf("health procedência = (%q, %q), quer (6257, turno do arquivo)",
			health.DadosEleicao, health.DadosTurno)
	}
	if health.UFs != 0 {
		t.Errorf("health.ufs = %d, quer 0 (não servir contagem do turno anterior)", health.UFs)
	}
	if health.DadosAviso == "" {
		t.Error("health.dados_aviso vazio, quer o motivo da incoerência")
	}

	config := struct {
		Turno      string `json:"turno"`
		Incoerente bool   `json:"incoerente"`
		DadosTurno string `json:"dados_turno"`
	}{}
	if err := json.Unmarshal(pegar("/api/config"), &config); err != nil {
		t.Fatalf("config: %v", err)
	}
	if !config.Incoerente || config.Turno != "2" || config.DadosTurno == "" {
		t.Errorf("config = %+v, quer incoerente true, turno 2 e dados_turno preenchido", config)
	}

	estados := struct {
		Turno        string `json:"turno"`
		Incoerente   bool   `json:"incoerente"`
		DadosSemDado bool   `json:"dados_sem_dado"`
		Nacional     struct {
			PctApurado float64 `json:"pct_apurado"`
			VV         int64   `json:"vv"`
		} `json:"nacional"`
		UFs []json.RawMessage `json:"ufs"`
	}{}
	if err := json.Unmarshal(pegar("/api/estados"), &estados); err != nil {
		t.Fatalf("estados: %v", err)
	}
	if !estados.Incoerente || !estados.DadosSemDado {
		t.Errorf("estados = incoerente %v / sem_dado %v, quer ambos true",
			estados.Incoerente, estados.DadosSemDado)
	}
	if len(estados.UFs) != 0 {
		t.Errorf("estados.ufs = %d itens, quer 0", len(estados.UFs))
	}
	if estados.Nacional.PctApurado != 0 || estados.Nacional.VV != 0 {
		t.Errorf("estados.nacional = %+v, quer zerado", estados.Nacional)
	}
	if estados.Turno != "2" {
		t.Errorf("estados.turno = %q, quer %q", estados.Turno, "2")
	}

	home := struct {
		Turno   string `json:"turno"`
		Publico struct {
			SemDado    bool              `json:"sem_dado"`
			Incoerente bool              `json:"incoerente"`
			GeradoEm   string            `json:"gerado_em"`
			UFs        []json.RawMessage `json:"ufs"`
			Nacional   struct {
				PctApurado float64 `json:"pct_apurado"`
			} `json:"nacional"`
		} `json:"publico"`
	}{}
	if err := json.Unmarshal(pegar("/api/home"), &home); err != nil {
		t.Fatalf("home: %v", err)
	}
	if !home.Publico.SemDado || !home.Publico.Incoerente {
		t.Errorf("home.publico = sem_dado %v / incoerente %v, quer ambos true",
			home.Publico.SemDado, home.Publico.Incoerente)
	}
	if len(home.Publico.UFs) != 0 || home.Publico.Nacional.PctApurado != 0 {
		t.Errorf("home.publico ainda carrega número: %d ufs, pct %v",
			len(home.Publico.UFs), home.Publico.Nacional.PctApurado)
	}
	if home.Turno != "2" {
		t.Errorf("home.turno = %q, quer %q", home.Turno, "2")
	}

	malha := struct {
		Type     string            `json:"type"`
		Features []json.RawMessage `json:"features"`
		SemDado  bool              `json:"sem_dado"`
	}{}
	if err := json.Unmarshal(pegar("/api/ufs.geojson"), &malha); err != nil {
		t.Fatalf("ufs.geojson: %v", err)
	}
	if len(malha.Features) != 0 || !malha.SemDado || malha.Type != "FeatureCollection" {
		t.Errorf("ufs.geojson = %d features / sem_dado %v / type %q, quer 0 / true / FeatureCollection",
			len(malha.Features), malha.SemDado, malha.Type)
	}
}

// TestCoerenciaDeTurno garante que o portão não fecha quando o arquivo é do
// turno do painel: aí o número tem de continuar saindo (senão o painel viraria
// uma tela de espera permanente).
func TestCoerenciaDeTurno(t *testing.T) {
	t.Setenv("ELEICAO", "6257")
	t.Setenv("TURNO", "1")
	aplicacao := novaAppDeTeste(t)

	procedencia := aplicacao.procedenciaDoSnapshot()
	if procedencia.Incoerente {
		t.Fatalf("incoerente = true com painel e arquivo na mesma eleição (%+v)", procedencia)
	}

	requisicao := httptest.NewRequest(http.MethodGet, "/api/estados", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	var estados struct {
		Incoerente bool              `json:"incoerente"`
		UFs        []json.RawMessage `json:"ufs"`
		Nacional   struct {
			PctApurado float64 `json:"pct_apurado"`
		} `json:"nacional"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &estados); err != nil {
		t.Fatalf("estados: %v", err)
	}
	if estados.Incoerente {
		t.Error("estados.incoerente = true, quer false")
	}
	if len(estados.UFs) != 27 {
		t.Errorf("estados.ufs = %d, quer 27", len(estados.UFs))
	}
	if !(estados.Nacional.PctApurado > 0) {
		t.Errorf("estados.nacional.pct_apurado = %v, quer > 0", estados.Nacional.PctApurado)
	}
}

// TestNumeroDoTurno cobre a leitura do ordinal: o ambiente traz "2" e o
// arquivo traz "2º turno" — os dois têm de virar o mesmo número.
func TestNumeroDoTurno(t *testing.T) {
	casos := map[string]string{
		"1":                 "1",
		"2":                 "2",
		"1º turno":          "1",
		"2º turno":          "2",
		"":                  "",
		"turno não declara": "",
	}
	for entrada, quer := range casos {
		if obtido := numeroDoTurno(entrada); obtido != quer {
			t.Errorf("numeroDoTurno(%q) = %q, quer %q", entrada, obtido, quer)
		}
	}
	if strings.TrimSpace(nacionalZerado) == "" {
		t.Fatal("nacionalZerado vazio")
	}
}
