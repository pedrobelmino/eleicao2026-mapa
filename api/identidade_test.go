package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Contrato que o card de estado do front (DetailCard) consome: 27 UFs, cada uma
// com 2 a 4 figurinhas e pelo menos 1 destaque. O teste olha o dado REAL servido
// pela rota — não o arquivo em disco —, então também cobre a carga no boot.
func TestIdentidadeEstados(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/estados/identidade", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200: %s", resposta.Code, resposta.Body.String())
	}

	var corpo struct {
		UF map[string]struct {
			Nome       string   `json:"nome"`
			Apelido    string   `json:"apelido"`
			Figurinhas []string `json:"figurinhas"`
			Destaques  []string `json:"destaques"`
		} `json:"UF"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}

	if len(corpo.UF) != 27 {
		t.Fatalf("UFs = %d, quer 27", len(corpo.UF))
	}

	for sigla, info := range corpo.UF {
		if info.Nome == "" {
			t.Errorf("%s: nome vazio", sigla)
		}
		if total := len(info.Figurinhas); total < 2 || total > 4 {
			t.Errorf("%s: %d figurinhas, quer 2..4", sigla, total)
		}
		if len(info.Destaques) < 1 {
			t.Errorf("%s: sem destaque", sigla)
		}
	}

	ce, existe := corpo.UF["CE"]
	if !existe {
		t.Fatal("CE ausente da curadoria")
	}
	if ce.Nome != "Ceará" {
		t.Errorf("CE.nome = %q, quer Ceará", ce.Nome)
	}
	if len(ce.Figurinhas) != 3 || len(ce.Destaques) != 3 {
		t.Errorf("CE: figurinhas=%d destaques=%d, quer 3/3", len(ce.Figurinhas), len(ce.Destaques))
	}
}

// Sem o arquivo o mapa continua de pé: a rota responde {"UF":{}} e 200, e o
// card de estado cai no layout sem figurinha.
func TestIdentidadeAusente(t *testing.T) {
	dir := t.TempDir()
	for _, nome := range []string{"publico.json", "malha_uf.geojson"} {
		conteudo, err := os.ReadFile(filepath.Join("..", "dados", nome))
		if err != nil {
			t.Fatalf("ler %s dos dados reais: %v", nome, err)
		}
		if err := os.WriteFile(filepath.Join(dir, nome), conteudo, 0o644); err != nil {
			t.Fatalf("copiar %s para o diretório sintético: %v", nome, err)
		}
	}

	t.Setenv("DADOS_DIR", dir)
	aplicacao, err := novaApp(carregarConfig())
	if err != nil {
		t.Fatalf("criar aplicação sem estados_identidade.json: %v", err)
	}

	requisicao := httptest.NewRequest(http.MethodGet, "/api/estados/identidade", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}

	var corpo struct {
		UF map[string]json.RawMessage `json:"UF"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if len(corpo.UF) != 0 {
		t.Errorf("UF = %d entradas, quer 0", len(corpo.UF))
	}
}
