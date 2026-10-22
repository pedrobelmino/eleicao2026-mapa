package main

// Testes da contagem anônima. Rodam contra um diretório temporário: o banco de
// produção (`~/.hermes/painel_publico/visitas.db`) nunca é tocado.
//
// METRICAS_GEO_API=0 desliga o fallback remoto (ip-api.com), então nenhum teste
// sai para a rede e nenhum IP de teste é enviado a terceiro.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func anonimoDeTeste(t *testing.T) *anonimo {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("METRICAS_DIR", dir)
	t.Setenv("METRICAS_DB", filepath.Join(dir, "visitas.db"))
	t.Setenv("METRICAS_SAL", filepath.Join(dir, ".salt"))
	t.Setenv("METRICAS_GEO", filepath.Join(dir, "geo", "inexistente.mmdb"))
	t.Setenv("METRICAS_GEO_API", "0")

	contagem, err := novoAnonimo()
	if err != nil {
		t.Fatalf("abrir banco de métricas de teste: %v", err)
	}
	t.Cleanup(contagem.fechar)
	return contagem
}

func TestAnonimoDuasVisitasMesmoDia(t *testing.T) {
	contagem := anonimoDeTeste(t)
	agora := time.Now()

	for i := 0; i < 2; i++ {
		if _, err := contagem.registrar("189.4.1.1", "Mozilla/5.0 (X11; Linux x86_64) Chrome/120", agora); err != nil {
			t.Fatalf("registrar visita %d: %v", i+1, err)
		}
	}

	resumo, err := contagem.resumo(14)
	if err != nil {
		t.Fatalf("resumo: %v", err)
	}
	hoje := resumo["hoje"].(map[string]any)
	if visitas := hoje["visitas"].(int); visitas != 2 {
		t.Errorf("hoje.visitas = %d, quer 2", visitas)
	}
	if pessoas := hoje["pessoas"].(int); pessoas != 1 {
		t.Errorf("hoje.pessoas = %d, quer 1 (mesmo IP no mesmo dia)", pessoas)
	}
}

func TestAnonimoHashMudaPorDia(t *testing.T) {
	contagem := anonimoDeTeste(t)
	agora := time.Now()

	primeira, err := contagem.registrar("189.4.1.1", "Chrome/120", agora.AddDate(0, 0, -1))
	if err != nil {
		t.Fatalf("registrar ontem: %v", err)
	}
	segunda, err := contagem.registrar("189.4.1.1", "Chrome/120", agora)
	if err != nil {
		t.Fatalf("registrar hoje: %v", err)
	}

	if primeira.IPHash == segunda.IPHash {
		t.Fatalf("hash igual em dias diferentes (%s) — a trajetória ficaria emendável", primeira.IPHash)
	}
	if len(primeira.IPHash) != 32 {
		t.Errorf("hash com %d caracteres, quer 32", len(primeira.IPHash))
	}
}

func TestAnonimoFiltraRobo(t *testing.T) {
	contagem := anonimoDeTeste(t)
	agora := time.Now()

	if _, err := contagem.registrar("189.4.1.1", "Googlebot/2.1 (+http://www.google.com/bot.html)", agora); err != nil {
		t.Fatalf("registrar robô: %v", err)
	}
	if _, err := contagem.registrar("189.4.1.2", "curl/8.5.0", agora); err != nil {
		t.Fatalf("registrar curl: %v", err)
	}
	if _, err := contagem.registrar("189.4.1.3", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605", agora); err != nil {
		t.Fatalf("registrar pessoa: %v", err)
	}

	resumo, err := contagem.resumo(14)
	if err != nil {
		t.Fatalf("resumo: %v", err)
	}
	if bots := resumo["bots_filtrados"].(int); bots != 2 {
		t.Errorf("bots_filtrados = %d, quer 2", bots)
	}
	total := resumo["total"].(map[string]any)
	if visitas := total["visitas"].(int); visitas != 1 {
		t.Errorf("total.visitas = %d, quer 1 (robô fora da conta)", visitas)
	}
}

func TestAnonimoNaoVazaIPNemUserAgent(t *testing.T) {
	contagem := anonimoDeTeste(t)
	userAgent := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36"

	if _, err := contagem.registrar("189.4.1.1", userAgent, time.Now()); err != nil {
		t.Fatalf("registrar: %v", err)
	}

	resumo, err := contagem.resumo(14)
	if err != nil {
		t.Fatalf("resumo: %v", err)
	}
	corpo, err := json.Marshal(resumo)
	if err != nil {
		t.Fatalf("serializar resumo: %v", err)
	}
	texto := string(corpo)

	for _, proibido := range []string{"189.4.1.1", "Windows NT", "Safari/537"} {
		if strings.Contains(texto, proibido) {
			t.Errorf("resumo contém dado pessoal %q: %s", proibido, texto)
		}
	}

	// O user-agent cru não é gravado: no banco só cabe o resumo.
	var guardado string
	if err := contagem.db.QueryRow("SELECT ua FROM visitas LIMIT 1").Scan(&guardado); err != nil {
		t.Fatalf("ler ua gravado: %v", err)
	}
	if guardado != "Chrome · Windows" {
		t.Errorf("ua gravado = %q, quer %q", guardado, "Chrome · Windows")
	}
	if strings.Contains(guardado, "Mozilla") {
		t.Errorf("ua gravado guardou a string inteira: %q", guardado)
	}
}

func TestAnonimoRetencaoApagaAntigo(t *testing.T) {
	contagem := anonimoDeTeste(t)
	agora := time.Now()

	if _, err := contagem.registrar("189.4.1.1", "Chrome/120", agora.AddDate(0, 0, -200)); err != nil {
		t.Fatalf("registrar visita antiga: %v", err)
	}
	var antes int
	if err := contagem.db.QueryRow("SELECT COUNT(*) FROM visitas").Scan(&antes); err != nil {
		t.Fatalf("contar antes: %v", err)
	}
	if antes != 1 {
		t.Fatalf("linhas antes = %d, quer 1", antes)
	}

	// A escrita de hoje aplica o corte de 180 dias e leva a linha de 200 dias.
	if _, err := contagem.registrar("189.4.1.1", "Chrome/120", agora); err != nil {
		t.Fatalf("registrar visita de hoje: %v", err)
	}
	var depois int
	if err := contagem.db.QueryRow("SELECT COUNT(*) FROM visitas").Scan(&depois); err != nil {
		t.Fatalf("contar depois: %v", err)
	}
	if depois != 1 {
		t.Errorf("linhas depois = %d, quer 1 (a antiga deveria ter sido apagada)", depois)
	}
}

func TestAnonimoSalPersistente(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("METRICAS_DIR", dir)
	t.Setenv("METRICAS_DB", filepath.Join(dir, "visitas.db"))
	t.Setenv("METRICAS_SAL", filepath.Join(dir, ".salt"))
	t.Setenv("METRICAS_GEO", filepath.Join(dir, "geo", "inexistente.mmdb"))
	t.Setenv("METRICAS_GEO_API", "0")

	primeira, err := novoAnonimo()
	if err != nil {
		t.Fatalf("primeira abertura: %v", err)
	}
	hash1 := primeira.hashIP("189.4.1.1", "2026-10-22")
	primeira.fechar()

	segunda, err := novoAnonimo()
	if err != nil {
		t.Fatalf("segunda abertura: %v", err)
	}
	defer segunda.fechar()
	hash2 := segunda.hashIP("189.4.1.1", "2026-10-22")

	if hash1 != hash2 {
		t.Fatalf("sal mudou entre aberturas: %s != %s (histórico ficaria órfão)", hash1, hash2)
	}

	info, err := os.Stat(filepath.Join(dir, ".salt"))
	if err != nil {
		t.Fatalf("stat do sal: %v", err)
	}
	if modo := info.Mode().Perm(); modo != 0o600 {
		t.Errorf("permissão do sal = %o, quer 600", modo)
	}
}

func TestAnonimoResumoCompleto(t *testing.T) {
	contagem := anonimoDeTeste(t)
	agora := time.Now()

	for i := 0; i < 3; i++ {
		if _, err := contagem.registrar("189.4.1."+string(rune('1'+i)), "Firefox/120", agora.AddDate(0, 0, -i)); err != nil {
			t.Fatalf("registrar dia %d: %v", i, err)
		}
	}

	resumo, err := contagem.resumo(14)
	if err != nil {
		t.Fatalf("resumo: %v", err)
	}
	for _, chave := range []string{"gerado_em", "hoje", "ontem", "total", "regioes",
		"estados", "serie", "bots_filtrados", "fonte_geo", "retencao_dias", "anonimato", "origem"} {
		if _, existe := resumo[chave]; !existe {
			t.Errorf("resumo sem a chave %q", chave)
		}
	}
	serie := resumo["serie"].([]map[string]any)
	if len(serie) != 3 {
		t.Fatalf("série com %d dias, quer 3", len(serie))
	}
	anterior := ""
	for _, dia := range serie {
		atual := dia["dia"].(string)
		if atual <= anterior {
			t.Errorf("série fora de ordem: %q depois de %q", atual, anterior)
		}
		anterior = atual
	}
}

func TestAnonimoVisitaResponde204(t *testing.T) {
	contagem := anonimoDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/visita", nil)
	requisicao.Header.Set("X-Real-IP", "189.4.1.1")
	requisicao.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux) Chrome/120")
	resposta := httptest.NewRecorder()
	contagem.handleVisita(resposta, requisicao)

	if resposta.Code != http.StatusNoContent {
		t.Fatalf("status = %d, quer 204", resposta.Code)
	}
	var linhas int
	if err := contagem.db.QueryRow("SELECT COUNT(*) FROM visitas").Scan(&linhas); err != nil {
		t.Fatalf("contar linhas: %v", err)
	}
	if linhas != 1 {
		t.Errorf("linhas = %d, quer 1", linhas)
	}
}

func TestAnonimoVisitaMetodoErrado(t *testing.T) {
	contagem := anonimoDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodPost, "/api/visita", nil)
	resposta := httptest.NewRecorder()
	contagem.handleVisita(resposta, requisicao)

	if resposta.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /api/visita = %d, quer 405", resposta.Code)
	}
}
