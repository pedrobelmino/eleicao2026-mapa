package main

// Testes da borda: cabeçalhos, validação de parâmetros, método, limite de taxa
// e concorrência, IP real e 404 sem stack. São as travas que a bateria de
// ataque em scripts/seguranca/teste_ataques.sh exercita contra o nginx; aqui
// elas são exercitadas contra o handler Go, que é a segunda barreira.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCabecalhosDeSeguranca(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	esperados := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
	}
	for nome, quer := range esperados {
		if obtido := resposta.Header().Get(nome); obtido != quer {
			t.Errorf("%s = %q, quer %q", nome, obtido, quer)
		}
	}
	if csp := resposta.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'none'") {
		t.Errorf("CSP = %q, quer default-src 'none'", csp)
	}
	if permissao := resposta.Header().Get("Permissions-Policy"); !strings.Contains(permissao, "geolocation=()") {
		t.Errorf("Permissions-Policy = %q, quer geolocation=()", permissao)
	}
	if cache := resposta.Header().Get("Cache-Control"); cache != "no-store" {
		t.Errorf("Cache-Control = %q, quer no-store na API", cache)
	}
}

func TestMetodosNaoPermitidos(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	for _, metodo := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch, http.MethodTrace, http.MethodOptions} {
		requisicao := httptest.NewRequest(metodo, "/api/estados", nil)
		resposta := httptest.NewRecorder()
		aplicacao.handler().ServeHTTP(resposta, requisicao)

		if resposta.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: status = %d, quer 405", metodo, resposta.Code)
			continue
		}
		if permissao := resposta.Header().Get("Allow"); permissao != "GET, HEAD" {
			t.Errorf("%s: Allow = %q, quer GET, HEAD", metodo, permissao)
		}
		if corpo := resposta.Body.String(); strings.Contains(strings.ToLower(corpo), "goroutine") {
			t.Errorf("%s: corpo vazou stack: %q", metodo, corpo)
		}
	}
}

func TestParametrosRecusados(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	casos := []struct {
		nome   string
		alvo   string
		status int
	}{
		{"consulta longa demais", "/api/health?" + strings.Repeat("a=1&", 300), http.StatusRequestURITooLong},
		{"parâmetros demais", "/api/health?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9", http.StatusBadRequest},
		{"valor com aspas", `/api/replay?modo=2022'`, http.StatusBadRequest},
		{"valor com script", "/api/replay?modo=%3Cscript%3Ealert(1)%3C%2Fscript%3E", http.StatusBadRequest},
		{"valor com crlf", "/api/replay?modo=2022%0d%0aX-Injetado:%201", http.StatusBadRequest},
		{"parâmetro desconhecido na rota", "/api/estados?sql=1", http.StatusBadRequest},
		{"parâmetro desconhecido em locais", "/api/uf/SP/locais?cd=1&x=2", http.StatusBadRequest},
		{"valor longo em cd", "/api/uf/SP/locais?cd=" + strings.Repeat("9", 200), http.StatusBadRequest},
		{"travessia no caminho", "/api/uf/../../dados/publico.json", http.StatusNotFound},
	}

	for _, caso := range casos {
		requisicao := httptest.NewRequest(http.MethodGet, caso.alvo, nil)
		resposta := httptest.NewRecorder()
		aplicacao.handler().ServeHTTP(resposta, requisicao)

		if resposta.Code != caso.status {
			t.Errorf("%s: status = %d, quer %d (corpo %q)", caso.nome, resposta.Code, caso.status, resposta.Body.String())
			continue
		}
		if corpo := resposta.Body.String(); strings.Contains(corpo, "<script>") || strings.Contains(corpo, "goroutine") {
			t.Errorf("%s: corpo ecoou entrada ou stack: %q", caso.nome, corpo)
		}
		if tipo := resposta.Header().Get("Content-Type"); !strings.HasPrefix(tipo, "application/json") {
			t.Errorf("%s: Content-Type = %q, quer application/json", caso.nome, tipo)
		}
	}
}

func TestParametrosLegitimosPassam(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	for _, alvo := range []string{"/api/replay?modo=2022", "/api/replay?modo=2026", "/api/health"} {
		requisicao := httptest.NewRequest(http.MethodGet, alvo, nil)
		resposta := httptest.NewRecorder()
		aplicacao.handler().ServeHTTP(resposta, requisicao)
		if resposta.Code != http.StatusOK {
			t.Errorf("%s: status = %d, quer 200 (corpo %q)", alvo, resposta.Code, resposta.Body.String())
		}
	}
}

func TestLimitePorIP(t *testing.T) {
	limitador := novoLimitador(limites{TaxaPorIP: 1, RajadaPorIP: 3, MaxSimultaneas: 100, MaxPorIP: 100})

	for i := 0; i < 3; i++ {
		if liberado, motivo := limitador.permitir("189.4.1.1"); !liberado {
			t.Fatalf("requisição %d deveria passar, recusada por %q", i+1, motivo)
		}
		limitador.liberar("189.4.1.1")
	}
	if liberado, motivo := limitador.permitir("189.4.1.1"); liberado || motivo != "taxa" {
		t.Fatalf("4ª requisição deveria ser recusada por taxa, veio liberado=%v motivo=%q", liberado, motivo)
	}
	if liberado, _ := limitador.permitir("189.4.2.2"); !liberado {
		t.Error("outro IP deveria ter balde próprio")
	}

	stats := limitador.estatisticas()
	if stats.Rejeitados429 != 1 {
		t.Errorf("Rejeitados429 = %d, quer 1", stats.Rejeitados429)
	}
}

func TestLimiteRecarregaComTempo(t *testing.T) {
	limitador := novoLimitador(limites{TaxaPorIP: 100, RajadaPorIP: 1, MaxSimultaneas: 10, MaxPorIP: 10})

	if liberado, _ := limitador.permitir("10.0.0.9"); !liberado {
		t.Fatal("primeira requisição deveria passar")
	}
	limitador.liberar("10.0.0.9")
	if liberado, _ := limitador.permitir("10.0.0.9"); liberado {
		t.Fatal("segunda imediata deveria ser recusada (rajada 1)")
	}

	time.Sleep(30 * time.Millisecond) // a 100 req/s, 30ms devolvem 3 fichas
	if liberado, motivo := limitador.permitir("10.0.0.9"); !liberado {
		t.Fatalf("depois do tempo a ficha deveria voltar, recusado por %q", motivo)
	}
}

func TestLimiteDeConcorrenciaPorIP(t *testing.T) {
	limitador := novoLimitador(limites{TaxaPorIP: 1000, RajadaPorIP: 1000, MaxSimultaneas: 100, MaxPorIP: 2})

	if liberado, _ := limitador.permitir("10.0.0.7"); !liberado {
		t.Fatal("1ª deveria passar")
	}
	if liberado, _ := limitador.permitir("10.0.0.7"); !liberado {
		t.Fatal("2ª deveria passar")
	}
	if liberado, motivo := limitador.permitir("10.0.0.7"); liberado || motivo != "simultaneas" {
		t.Fatalf("3ª simultânea deveria ser recusada por simultaneas, veio %v/%q", liberado, motivo)
	}

	limitador.liberar("10.0.0.7")
	if liberado, _ := limitador.permitir("10.0.0.7"); !liberado {
		t.Fatal("depois de liberar, deveria voltar a passar")
	}
}

func TestLimiteGlobalSaturado(t *testing.T) {
	limitador := novoLimitador(limites{TaxaPorIP: 1000, RajadaPorIP: 1000, MaxSimultaneas: 1, MaxPorIP: 10})

	if liberado, _ := limitador.permitir("10.0.0.1"); !liberado {
		t.Fatal("1ª deveria passar")
	}
	if liberado, motivo := limitador.permitir("10.0.0.2"); liberado || motivo != "ocupado" {
		t.Fatalf("com o teto global cheio, outro IP deveria receber ocupado, veio %v/%q", liberado, motivo)
	}
	if stats := limitador.estatisticas(); stats.Rejeitados503 != 1 {
		t.Errorf("Rejeitados503 = %d, quer 1", stats.Rejeitados503)
	}
}

func TestLimpezaDescartaBaldesOciosos(t *testing.T) {
	limitador := novoLimitador(limites{TaxaPorIP: 10, RajadaPorIP: 10, MaxSimultaneas: 10, MaxPorIP: 10})

	if liberado, _ := limitador.permitir("10.1.1.1"); !liberado {
		t.Fatal("deveria passar")
	}
	limitador.liberar("10.1.1.1")

	if removidos := limitador.limpar(time.Nanosecond); removidos != 1 {
		t.Errorf("removidos = %d, quer 1", removidos)
	}
	if stats := limitador.estatisticas(); stats.IPsAtivos != 0 {
		t.Errorf("IPsAtivos = %d, quer 0", stats.IPsAtivos)
	}
}

func TestIPDoClienteOrdemEValidacao(t *testing.T) {
	casos := []struct {
		nome      string
		cabecalho map[string]string
		remoto    string
		quer      string
	}{
		{"CF-Connecting-IP ganha de tudo", map[string]string{"CF-Connecting-IP": "189.4.1.1", "X-Real-IP": "10.0.0.1"}, "192.168.0.1:5555", "189.4.1.1"},
		{"X-Real-IP", map[string]string{"X-Real-IP": "189.4.1.2"}, "192.168.0.1:5555", "189.4.1.2"},
		{"XFF primeiro da lista", map[string]string{"X-Forwarded-For": "189.4.1.3, 172.18.0.1"}, "192.168.0.1:5555", "189.4.1.3"},
		{"lixo cai para o socket", map[string]string{"X-Real-IP": "não é ip"}, "192.168.0.1:5555", "192.168.0.1"},
		{"ipv4 mapeado em ipv6", map[string]string{"X-Real-IP": "::ffff:189.4.1.4"}, "192.168.0.1:5555", "189.4.1.4"},
		{"zona ipv6", map[string]string{"X-Real-IP": "fe80::1%eth0"}, "192.168.0.1:5555", "fe80::1"},
	}

	for _, caso := range casos {
		requisicao := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		requisicao.RemoteAddr = caso.remoto
		for nome, valor := range caso.cabecalho {
			requisicao.Header.Set(nome, valor)
		}
		if obtido := ipDoCliente(requisicao); obtido != caso.quer {
			t.Errorf("%s: ipDoCliente = %q, quer %q", caso.nome, obtido, caso.quer)
		}
	}
}

func TestRecuperacaoDePanicoNaoVazaStack(t *testing.T) {
	manipulador := withCabecalhosSeguranca(withRecovery(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("falha proposital no meio do handler")
	})))

	requisicao := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	resposta := httptest.NewRecorder()
	manipulador.ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, quer 500", resposta.Code)
	}
	corpo := resposta.Body.String()
	if !strings.Contains(corpo, "erro interno") {
		t.Errorf("corpo = %q, quer mensagem genérica", corpo)
	}
	if strings.Contains(corpo, "panic") || strings.Contains(corpo, "goroutine") || strings.Contains(corpo, "main.go") {
		t.Errorf("corpo vazou detalhe interno: %q", corpo)
	}
}

func TestRotaInternaExigeToken(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	t.Setenv("METRICAS_TOKEN", "")
	requisicao := httptest.NewRequest(http.MethodGet, "/api/interno/metricas", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)
	if resposta.Code != http.StatusForbidden {
		t.Fatalf("sem token configurado: status = %d, quer 403 (falha fechada)", resposta.Code)
	}

	t.Setenv("METRICAS_TOKEN", "token-de-teste-com-32-caracteres-ok")
	requisicao = httptest.NewRequest(http.MethodGet, "/api/interno/metricas", nil)
	resposta = httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)
	if resposta.Code != http.StatusUnauthorized {
		t.Fatalf("sem credencial: status = %d, quer 401", resposta.Code)
	}

	requisicao = httptest.NewRequest(http.MethodGet, "/api/interno/metricas?token=errado", nil)
	resposta = httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)
	if resposta.Code != http.StatusForbidden {
		t.Fatalf("token errado: status = %d, quer 403", resposta.Code)
	}

	requisicao = httptest.NewRequest(http.MethodGet, "/api/interno/metricas", nil)
	requisicao.Header.Set("X-Metricas-Token", "token-de-teste-com-32-caracteres-ok")
	resposta = httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)
	if resposta.Code != http.StatusOK {
		t.Fatalf("token correto: status = %d, quer 200 (corpo %q)", resposta.Code, resposta.Body.String())
	}

	var corpo map[string]any
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("JSON do painel: %v", err)
	}
	for _, chave := range []string{"gerado_em", "uptime_s", "http", "limites", "saude", "anonimo"} {
		if _, existe := corpo[chave]; !existe {
			t.Errorf("resposta sem a chave %q", chave)
		}
	}
	if _, vazou := corpo["token"]; vazou {
		t.Error("resposta não pode conter o token")
	}
}

func TestPainelInternoRespondeHTML(t *testing.T) {
	aplicacao := novaAppDeTeste(t)
	t.Setenv("METRICAS_TOKEN", "token-de-teste-com-32-caracteres-ok")

	requisicao := httptest.NewRequest(http.MethodGet, "/api/interno/painel?token=token-de-teste-com-32-caracteres-ok", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}
	if tipo := resposta.Header().Get("Content-Type"); !strings.HasPrefix(tipo, "text/html") {
		t.Errorf("Content-Type = %q, quer text/html", tipo)
	}
	corpo := resposta.Body.String()
	for _, trecho := range []string{"Métricas", "Rate limit", "Saúde", "Visitas"} {
		if !strings.Contains(corpo, trecho) {
			t.Errorf("painel sem a seção %q", trecho)
		}
	}
	if strings.Contains(corpo, "token-de-teste-com-32-caracteres-ok\"") {
		t.Error("o token não deve aparecer em atributo de HTML")
	}
}

func TestVisitaRespondeSempre204(t *testing.T) {
	aplicacao := novaAppDeTeste(t)
	if aplicacao.anon == nil {
		t.Skip("contagem anônima indisponível neste ambiente")
	}

	requisicao := httptest.NewRequest(http.MethodGet, "/api/visita", nil)
	requisicao.Header.Set("X-Real-IP", "189.4.1.1")
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusNoContent {
		t.Fatalf("status = %d, quer 204 (corpo %q)", resposta.Code, resposta.Body.String())
	}
}

func TestRotaDesconhecidaNaoVazaCaminho(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	for _, alvo := range []string{"/api/nao-existe", "/dados/publico.json", "/api/uf/XX/municipios", "/api/uf/SP/secoes_SP.json"} {
		requisicao := httptest.NewRequest(http.MethodGet, alvo, nil)
		resposta := httptest.NewRecorder()
		aplicacao.handler().ServeHTTP(resposta, requisicao)

		if resposta.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, quer 404", alvo, resposta.Code)
			continue
		}
		corpo := resposta.Body.String()
		for _, proibido := range []string{"/home/pedro", "publico.json", "goroutine", ".go:"} {
			if strings.Contains(corpo, proibido) {
				t.Errorf("%s: corpo vazou %q: %q", alvo, proibido, corpo)
			}
		}
	}
}
