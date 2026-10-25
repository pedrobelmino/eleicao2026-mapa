package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// TestCORSRestritoFixaAsOrigens é a trava do item de borda: a API deixa de
// responder "*" e passa a ecoar apenas a origem do site e a mesma origem.
func TestCORSRestritoFixaAsOrigens(t *testing.T) {
	aplicacao := novaAppDeTeste(t)
	servidor := aplicacao.handler()

	casos := []struct {
		nome     string
		alvo     string
		host     string
		proto    string
		origem   string
		esperado string
	}{
		{"origem do site", "/api/health", "eleicao2026.belmino.dev", "https", origemPublica, origemPublica},
		{"mesma origem via proxy", "/api/health", "eleicao2026.belmino.dev", "https", "https://eleicao2026.belmino.dev", "https://eleicao2026.belmino.dev"},
		{"mesma origem local", "/api/health", "127.0.0.1:8110", "http", "http://127.0.0.1:8110", "http://127.0.0.1:8110"},
		{"origem estranha", "/api/health", "eleicao2026.belmino.dev", "https", "https://exemplo.com", ""},
		{"subdominio parecido", "/api/health", "eleicao2026.belmino.dev", "https", "https://eleicao2026.belmino.dev.mau.com", ""},
		{"null", "/api/health", "eleicao2026.belmino.dev", "https", "null", ""},
		{"sem origin", "/api/health", "eleicao2026.belmino.dev", "https", "", ""},
		{"fora de /api/", "/mapa", "eleicao2026.belmino.dev", "https", origemPublica, ""},
	}

	for _, caso := range casos {
		t.Run(caso.nome, func(t *testing.T) {
			requisicao := httptest.NewRequest(http.MethodGet, caso.alvo, nil)
			requisicao.Host = caso.host
			requisicao.Header.Set("X-Forwarded-Proto", caso.proto)
			if caso.origem != "" {
				requisicao.Header.Set("Origin", caso.origem)
			}
			resposta := httptest.NewRecorder()
			servidor.ServeHTTP(resposta, requisicao)

			if obtido := resposta.Header().Get("Access-Control-Allow-Origin"); obtido != caso.esperado {
				t.Fatalf("Access-Control-Allow-Origin = %q, quer %q", obtido, caso.esperado)
			}
			if caso.esperado != "" && resposta.Header().Get("Vary") == "" {
				t.Fatal("Vary não foi enviado junto da origem")
			}
		})
	}
}

// TestSerie2022Cache fia o cache: duas chamadas seguidas servem os mesmos
// bytes sem reler o arquivo, e uma escrita nova aparece quando o cache vence.
func TestSerie2022Cache(t *testing.T) {
	arquivo := filepath.Join(t.TempDir(), "serie_2022.jsonl")
	primeiro := `{"em":"2022-10-02T17:04:47","pct_apurado":1.5}
{"em":"2022-10-02T17:04:51","pct_apurado":2.5}
`
	if err := os.WriteFile(arquivo, []byte(primeiro), 0o600); err != nil {
		t.Fatalf("criar fixture: %v", err)
	}
	t.Setenv("SERIE_2022_FILE", arquivo)

	anterior := serie2022TTL
	serie2022TTL = time.Minute
	t.Cleanup(func() { serie2022TTL = anterior })

	aplicacao := novaAppDeTeste(t)

	pedir := func() []byte {
		requisicao := httptest.NewRequest(http.MethodGet, "/api/serie2022", nil)
		resposta := httptest.NewRecorder()
		aplicacao.handler().ServeHTTP(resposta, requisicao)
		if resposta.Code != http.StatusOK {
			t.Fatalf("status = %d, quer 200", resposta.Code)
		}
		if declarado := resposta.Header().Get("Content-Length"); declarado != "" &&
			declarado != strconv.Itoa(resposta.Body.Len()) {
			t.Fatalf("Content-Length = %q, corpo = %d", declarado, resposta.Body.Len())
		}
		return resposta.Body.Bytes()
	}

	cacheado := pedir()
	if string(cacheado) != string(pedir()) {
		t.Fatal("duas chamadas seguidas devolveram corpos diferentes")
	}

	// Arquivo reescrito com o MESMO mtime: o cache continua servindo o corpo
	// antigo (prova de que não houve releitura). Quando o TTL vence, o
	// conteúdo novo aparece — é o que cobre escrita que preserva o mtime.
	informacao, err := os.Stat(arquivo)
	if err != nil {
		t.Fatalf("stat do fixture: %v", err)
	}
	segundo := `{"em":"2022-10-02T18:00:00","pct_apurado":100}
`
	if err := os.WriteFile(arquivo, []byte(segundo), 0o600); err != nil {
		t.Fatalf("regravar fixture: %v", err)
	}
	if err := os.Chtimes(arquivo, informacao.ModTime(), informacao.ModTime()); err != nil {
		t.Fatalf("restaurar mtime: %v", err)
	}
	if string(pedir()) != string(cacheado) {
		t.Fatal("o cache releu o arquivo antes do TTL vencer")
	}

	serie2022TTL = 0
	novo := string(pedir())
	if novo == string(cacheado) {
		t.Fatal("payload não foi regerado depois de o TTL vencer")
	}
	if novo != `{"eleicao":"2022","fonte":"`+fonteSerie2022+`","total":1,"pontos":[{"em":"2022-10-02T18:00:00","pct_apurado":100}]}`+"\n" {
		t.Fatalf("corpo regerado inesperado: %s", novo)
	}
}
