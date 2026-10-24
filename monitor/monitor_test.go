package main

// Testes do que NÃO pode quebrar: leitura das duas gerações de log, a
// classificação de ataque e o filtro de rede do painel.

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseLinhaAntiga(t *testing.T) {
	linha := "127.0.0.1 2026-10-24T13:20:59+00:00 200 GET /healthz"
	ev, ok := parseLinha(linha)
	if !ok {
		t.Fatal("linha antiga deveria ser aceita")
	}
	if ev.IP != "127.0.0.1" || ev.Status != 200 || ev.Metodo != "GET" || ev.Caminho != "/healthz" {
		t.Fatalf("campos base errados: %+v", ev)
	}
	if ev.Host != hospedeiroDesconhecido {
		t.Fatalf("host de linha antiga deveria ser %q, veio %q", hospedeiroDesconhecido, ev.Host)
	}
	if ev.UA != "" || ev.Bot {
		t.Fatalf("linha antiga não tem UA: %+v", ev)
	}
	if !ev.Canario {
		t.Fatal("/healthz deveria ser canário")
	}
	if ev.Ataque != "" {
		t.Fatalf("healthz não é ataque: %q", ev.Ataque)
	}
}

func TestParseLinhaNovaComUAEspacos(t *testing.T) {
	linha := "191.31.15.133 2026-10-24T14:42:21+00:00 404 GET /.env " +
		"eleicao2026.belmino.dev 0 \"GET /.env HTTP/1.1\" Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"
	ev, ok := parseLinha(linha)
	if !ok {
		t.Fatal("linha nova deveria ser aceita")
	}
	if ev.Host != "eleicao2026.belmino.dev" {
		t.Fatalf("host errado: %q", ev.Host)
	}
	if ev.UA != "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0" {
		t.Fatalf("UA deveria ser o resto da linha (com espaços): %q", ev.UA)
	}
	if ev.Ataque != AtaqueSensivel {
		t.Fatalf("tipo errado: %q", ev.Ataque)
	}
	if ev.Bot {
		t.Fatal("Chrome real não é bot")
	}
}

func TestParseLinhaNovaComHostDiferente(t *testing.T) {
	linha := "108.174.5.113 2026-10-24T14:42:21+00:00 200 GET / belmino.dev 0 \"GET / HTTP/1.1\" curl/8.18.0"
	ev, _ := parseLinha(linha)
	if ev.Host != "belmino.dev" {
		t.Fatalf("host errado: %q", ev.Host)
	}
	if !ev.Bot {
		t.Fatal("curl/ é bot pelo critério da contagem anônima")
	}
}

func TestParseLinha400SemIPResolvido(t *testing.T) {
	// 400 gerado no parse da linha de requisição: $uri e $host vazios, e o IP
	// do socket (gateway do docker) não é o visitante. O painel não mente.
	linha := "172.19.0.1 2026-10-24T14:48:17+00:00 400 GET  _ 0 \"GET /../etc/passwd HTTP/1.1\" -"
	ev, ok := parseLinha(linha)
	if !ok {
		t.Fatal("linha deveria ser aceita")
	}
	if !ev.IPNaoResolvido || ev.IP != ipNaoResolvido {
		t.Fatalf("IP deveria ser marcado como não resolvido: %+v", ev)
	}
	if ev.Ataque != AtaqueTraversal {
		t.Fatalf("tipo errado: %q (alvo %q)", ev.Ataque, ev.Alvo)
	}
	if ev.Host != "_" {
		t.Fatalf("host deveria ser _: %q", ev.Host)
	}
}

func TestParseLinhaLixo(t *testing.T) {
	for _, linha := range []string{"", "   ", "sem campos", "1.2.3.4 nao-e-data 200 GET /", "1.2.3.4 2026-10-24T10:00:00+00:00 abc GET /"} {
		if _, ok := parseLinha(linha); ok {
			t.Fatalf("linha %q deveria ser recusada", linha)
		}
	}
}

func TestClassificacao(t *testing.T) {
	casos := []struct {
		nome   string
		metodo string
		alvo   string
		status int
		ua     string
		espera string
	}{
		{"env", "GET", "/.env", 404, "curl/8.0", AtaqueSensivel},
		{"git", "GET", "/.git/config", 404, "curl/8.0", AtaqueSensivel},
		{"admin", "GET", "/admin", 404, "curl/8.0", AtaqueSensivel},
		{"nginx", "GET", "/nginx.conf", 404, "curl/8.0", AtaqueSensivel},
		{"traversal", "GET", "/../etc/passwd", 400, "curl/8.0", AtaqueTraversal},
		{"traversal-codificado", "GET", "/..%2f..%2fetc%2fpasswd", 400, "curl/8.0", AtaqueTraversal},
		{"sqli", "GET", "/?id=1'%20OR%20'1'='1", 200, "Mozilla/5.0 (X11; Linux) Chrome/120", AtaqueSQLi},
		{"sqli-union", "GET", "/api/?q=1%20UNION%20SELECT%20senha", 200, "Mozilla/5.0 Chrome/120", AtaqueSQLi},
		{"scanner-ua", "GET", "/", 200, "sqlmap/1.8", AtaqueScanner},
		{"scanner-path", "GET", "/wp-admin/setup.php", 404, "Mozilla/5.0 Chrome/120", AtaqueScanner},
		{"metodo", "PROPFIND", "/", 405, "curl/8.0", AtaqueMetodo},
		{"flood", "GET", "/api/home", 429, "Mozilla/5.0 Chrome/120", AtaqueFlood},
		{"normal", "GET", "/mapa", 200, "Mozilla/5.0 (Windows NT 10.0) Chrome/120", ""},
		{"normal-query", "GET", "/api/home?uf=CE", 200, "Mozilla/5.0 (iPhone) Safari/604", ""},
	}
	for _, caso := range casos {
		ev := evento{Metodo: caso.metodo, Alvo: caso.alvo, Caminho: caso.alvo, Status: caso.status, UA: caso.ua, Host: "eleicao2026.belmino.dev"}
		if tipo := classificar(&ev); tipo != caso.espera {
			t.Errorf("%s: esperava %q, veio %q", caso.nome, caso.espera, tipo)
		}
	}
}

func TestFiltroDeRede(t *testing.T) {
	_, rede, err := net.ParseCIDR("192.168.5.0/24")
	if err != nil {
		t.Fatal(err)
	}
	s := &servidor{rede: rede}
	casos := []struct {
		ip     string
		libera bool
	}{
		{"127.0.0.1", true},
		{"::1", true},
		{"192.168.5.179", true},
		{"192.168.5.9", true},
		{"192.168.6.10", false},
		{"10.0.0.5", false},
		{"172.17.0.1", false}, // docker bridge: fora da LAN
		{"8.8.8.8", false},
		{"191.31.15.133", false},
	}
	for _, caso := range casos {
		if obtido := s.autorizado(net.ParseIP(caso.ip)); obtido != caso.libera {
			t.Errorf("%s: esperava %v, veio %v", caso.ip, caso.libera, obtido)
		}
	}
}

func TestNuncaEscutaEmQualquerInterface(t *testing.T) {
	_, rede, _ := net.ParseCIDR("192.168.5.0/24")
	lista, err := resolverEnderecos("0.0.0.0:8113,127.0.0.1:8113", rede)
	if err != nil {
		t.Fatalf("deveria sobrar o loopback: %v", err)
	}
	for _, endereco := range lista {
		if strings.HasPrefix(endereco, "0.0.0.0") || strings.HasPrefix(endereco, "[::]") {
			t.Fatalf("endereço coringa na lista: %v", lista)
		}
	}
	if len(lista) != 1 || lista[0] != "127.0.0.1:8113" {
		t.Fatalf("lista inesperada: %v", lista)
	}
}

func TestLeitorToleraLinhaPelaMetadeETruncamento(t *testing.T) {
	dir := t.TempDir()
	caminho := filepath.Join(dir, "acessos.log")
	conteudo := "127.0.0.1 2026-10-24T13:20:59+00:00 200 GET /healthz\n" +
		"191.31.15.133 2026-10-24T14:42:21+00:00 200 GET / eleicao2026.belmino.dev 0 \"GET / HTTP/1.1\" Mozilla/5.0 Chrome/120"
	if err := os.WriteFile(caminho, []byte(conteudo), 0o600); err != nil {
		t.Fatal(err)
	}

	coletor := novoColetor(filepath.Join(dir, "serie.json"))
	leitor := novoLeitor(caminho, coletor.registrar, coletor.reset)

	if n := leitor.passo(); n != 1 {
		t.Fatalf("esperava só a linha completa (1), veio %d", n)
	}

	// completa a linha pendente
	arquivo, _ := os.OpenFile(caminho, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = arquivo.WriteString("\n")
	arquivo.Close()
	if n := leitor.passo(); n != 1 {
		t.Fatalf("linha pendente completada deveria entrar (1), veio %d", n)
	}

	// truncamento (vigia corta em 5 MB)
	resetou := false
	leitor.aoReset = func() { resetou = true }
	if err := os.WriteFile(caminho, []byte("127.0.0.1 2026-10-24T15:00:00+00:00 200 GET /healthz\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if n := leitor.passo(); n != 1 {
		t.Fatalf("após truncar deveria reler a linha nova, veio %d", n)
	}
	if !resetou {
		t.Fatal("truncamento deveria avisar o coletor")
	}
}

func TestSerieEPersistencia(t *testing.T) {
	dir := t.TempDir()
	coletor := novoColetor(filepath.Join(dir, "serie.json"))

	agora := time.Now()
	coletor.registrar(evento{IP: "192.168.5.50", Quando: agora, Status: 200, Metodo: "GET", Caminho: "/mapa", Host: "eleicao2026.belmino.dev"})
	coletor.registrar(evento{IP: "192.168.5.51", Quando: agora, Status: 200, Metodo: "GET", Caminho: "/", Host: "belmino.dev", Bot: true, UA: "curl/8"})
	coletor.registrar(evento{IP: "191.31.15.133", Quando: agora, Status: 404, Metodo: "GET", Caminho: "/.env", Host: "eleicao2026.belmino.dev", Ataque: AtaqueSensivel})
	coletor.registrar(evento{IP: "127.0.0.1", Quando: agora, Status: 200, Metodo: "GET", Caminho: "/healthz", Host: "127.0.0.1", Canario: true})

	foto := coletor.foto()
	hora := foto.Janelas["1h"]
	if hora.Total != 3 {
		t.Fatalf("canário não pode contar como tráfego: total=%d", hora.Total)
	}
	if hora.Humano != 1 || hora.Bot != 1 || hora.Ataques != 1 {
		t.Fatalf("separação humano/bot/ataque errada: %+v", hora)
	}
	if foto.Canario != 1 {
		t.Fatalf("canário deveria ser contado à parte: %d", foto.Canario)
	}
	if len(hora.Hosts) != 2 {
		t.Fatalf("esperava 2 hosts, veio %d: %+v", len(hora.Hosts), hora.Hosts)
	}
	hosts := map[string]int{}
	for _, h := range hora.Hosts {
		hosts[h.Host] = h.Total
	}
	if hosts["eleicao2026.belmino.dev"] != 2 || hosts["belmino.dev"] != 1 {
		t.Fatalf("host separado errado: %+v", hosts)
	}

	coletor.mu.Lock()
	coletor.salvarSerie()
	coletor.mu.Unlock()

	novo := novoColetor(filepath.Join(dir, "serie.json"))
	dias := novo.serieDias(time.Now())
	ultimo := dias[len(dias)-1]
	if ultimo.Humano != 1 || ultimo.Bot != 1 || ultimo.Ataque != 1 {
		t.Fatalf("série diária não persistiu: %+v", ultimo)
	}
}
