package main

// Regressão do defeito MEDIDO em 24/10/2026: o gateway do docker
// (172.19.0.1) aparecia como "malicioso 100" no painel, com
// caminho_sensivel + injecao, porque as NOSSAS provas de ataque chegam ao
// nginx por ele. A regra nova: infra local nunca entra no escore.
//
// As linhas abaixo são CÓPIA LITERAL de var/defesa/acessos.log — três gerações
// do log_format convivem no mesmo arquivo (5 campos, sem aspas, e a atual).

import (
	"os"
	"strings"
	"testing"
	"time"
)

// linhasReaisDoLog: copiadas de var/defesa/acessos.log sem edição.
var linhasReaisDoLog = []struct {
	nome     string
	linha    string
	ip       string
	host     string
	caminho  string
	alvo     string
	uaTrecho string
	metodo   string
}{
	{
		nome:    "geração antiga, 5 campos (sem host)",
		linha:   "191.31.15.133 2026-10-24T13:25:19+00:00 404 GET /api/interno/painel",
		ip:      "191.31.15.133",
		host:    "?",
		caminho: "/api/interno/painel",
		alvo:    "/api/interno/painel",
		metodo:  "GET",
	},
	{
		nome:     "geração intermediária, host '-' e requisição sem aspas",
		linha:    "191.31.15.133 2026-10-24T14:47:08+00:00 404 GET /.env eleicao2026.belmino.dev 0 /.env Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0",
		ip:       "191.31.15.133",
		host:     "eleicao2026.belmino.dev",
		caminho:  "/.env",
		alvo:     "/.env",
		uaTrecho: "Chrome/120",
		metodo:   "GET",
	},
	{
		nome:    "formato atual: aspas na requisição crua (prova de injeção)",
		linha:   "172.19.0.1 2026-10-24T13:24:24+00:00 404 GET /api/uf/SP' OR 1=1/municipios - -",
		ip:      "172.19.0.1",
		host:    "?",
		caminho: "/api/uf/SP' OR 1=1/municipios",
		alvo:    "/api/uf/SP' OR 1=1/municipios",
		metodo:  "GET",
	},
	{
		nome:     "formato atual completo: 9 colunas, UA com espaços",
		linha:    `45.22.199.10 2026-10-24T15:19:56+00:00 200 GET /api/estados 127.0.0.1 0 "GET /api/estados HTTP/1.1" Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36`,
		ip:       "45.22.199.10",
		host:     "127.0.0.1",
		caminho:  "/api/estados",
		alvo:     "GET /api/estados HTTP/1.1",
		uaTrecho: "Chrome/141",
		metodo:   "GET",
	},
	{
		nome:    "400 antes do real_ip: URI vazia, host '_' → não resolvido",
		linha:   `172.19.0.1 2026-10-24T14:48:17+00:00 400 GET  _ 0 "GET /../etc/passwd HTTP/1.1" -`,
		ip:      ipNaoResolvido,
		host:    "_",
		caminho: "",
		alvo:    "GET /../etc/passwd HTTP/1.1",
		metodo:  "GET",
	},
}

func TestParserColunasCorretas(t *testing.T) {
	for _, caso := range linhasReaisDoLog {
		caso := caso
		t.Run(caso.nome, func(t *testing.T) {
			ev, ok := parseLinha(caso.linha)
			if !ok {
				t.Fatalf("linha real não parseia: %q", caso.linha)
			}
			if ev.IP != caso.ip {
				t.Fatalf("IP: esperado %q, obtido %q", caso.ip, ev.IP)
			}
			if ev.Host != caso.host {
				t.Fatalf("host: esperado %q, obtido %q", caso.host, ev.Host)
			}
			if ev.Caminho != caso.caminho {
				t.Fatalf("caminho: esperado %q, obtido %q", caso.caminho, ev.Caminho)
			}
			if ev.Alvo != caso.alvo {
				t.Fatalf("alvo: esperado %q, obtido %q", caso.alvo, ev.Alvo)
			}
			if ev.Metodo != caso.metodo {
				t.Fatalf("método: esperado %q, obtido %q", caso.metodo, ev.Metodo)
			}
			if caso.uaTrecho != "" && !strings.Contains(ev.UA, caso.uaTrecho) {
				t.Fatalf("UA: esperado conter %q, obtido %q", caso.uaTrecho, ev.UA)
			}
		})
	}
}

// O campo do UA nunca pode virar alvo: era isso que produzia ua_anomalo em
// linha de navegador real da geração sem aspas.
func TestUAForaDoAlvoNaGeracaoSemAspas(t *testing.T) {
	ev, ok := parseLinha("191.31.15.133 2026-10-24T14:47:08+00:00 404 GET /.env eleicao2026.belmino.dev 0 /.env Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0")
	if !ok {
		t.Fatal("linha não parseia")
	}
	if strings.Contains(ev.Alvo, "Mozilla") {
		t.Fatalf("alvo contaminado com UA: %q", ev.Alvo)
	}
	if uaAnomalo(ev.UA) {
		t.Fatalf("UA de navegador real marcado como anômalo: %q", ev.UA)
	}
}

func TestFaixaPrivadaReconhecida(t *testing.T) {
	privados := []string{
		"127.0.0.1", "127.0.0.53", "::1", "10.0.0.5", "10.255.255.254",
		"172.16.0.1", "172.17.0.1", "172.19.0.1", "172.20.0.2", "172.31.255.254",
		"192.168.0.10", "192.168.5.179", "169.254.169.254", "fe80::1", "fc00::1",
		"224.0.0.1", "0.0.0.0", ipNaoResolvido, "",
	}
	for _, ip := range privados {
		if !ipInfraLocal(ip) {
			t.Fatalf("%q deveria ser tratado como infra local", ip)
		}
	}
	publicos := []string{"191.31.15.133", "45.22.199.10", "45.22.33.44", "8.8.8.8", "2804:18:6041:aebd:b826:3443:9e3f:a5ef"}
	for _, ip := range publicos {
		if ipInfraLocal(ip) {
			t.Fatalf("%q é público e não pode ser descartado como infra", ip)
		}
	}
}

// O caso do defeito: as provas de ataque chegam pelo gateway do docker. Ele
// pode ter .env, /api/interno e SQLi no log — e ainda assim NÃO é suspeito.
func TestInfraLocalNuncaPontua(t *testing.T) {
	base := time.Date(2026, 10, 24, 13, 20, 0, 0, time.UTC)
	linhas := []string{
		"172.19.0.1 2026-10-24T13:24:24+00:00 404 GET /.env - -",
		"172.19.0.1 2026-10-24T13:24:24+00:00 404 GET /.git/config - -",
		"172.19.0.1 2026-10-24T13:24:24+00:00 404 GET /api/interno/painel - -",
		"172.19.0.1 2026-10-24T13:24:24+00:00 404 GET /api/uf/SP' OR 1=1/municipios - -",
		"127.0.0.1 2026-10-24T13:25:19+00:00 404 GET /api/interno/painel",
		"191.31.15.133 2026-10-24T13:25:19+00:00 404 GET /api/interno/painel",
	}
	eventos := make([]evento, 0, len(linhas))
	for _, linha := range linhas {
		ev, ok := parseLinha(linha)
		if !ok {
			t.Fatalf("linha não parseia: %q", linha)
		}
		eventos = append(eventos, ev)
	}

	lista := calcularSuspeitos(eventos, base.Add(time.Hour), 0)
	var temPublico, temInfra bool
	for _, s := range lista {
		if ipInfraLocal(s.IP) {
			temInfra = true
			t.Fatalf("infra local na lista de suspeitos: %+v", s)
		}
		if s.IP == "191.31.15.133" {
			temPublico = true
			// uma linha só já dá sondagem_interna + ua_anomalo = 50
			// ("observar"): o que importa é que ele NÃO desapareça.
			if s.Escore < escoreObservar {
				t.Fatalf("191.31.15.133 deveria seguir no escore, escore %d (%v)", s.Escore, s.Sinais)
			}
		}
	}
	if !temPublico {
		t.Fatal("191.31.15.133 desapareceu da lista de suspeitos")
	}
	if temInfra {
		t.Fatal("infra local entrou no escore")
	}

	// e o resumo da infra mostra o volume, fora da contagem
	resumo := resumoInfraLocal(eventos)
	if resumo.IPs != 2 || resumo.Eventos != 5 {
		t.Fatalf("resumo de infra: esperado 2 IPs / 5 eventos, veio %d / %d", resumo.IPs, resumo.Eventos)
	}
}

// Com o log real em disco, nenhum IP privado/loopback pode aparecer como
// suspeito — é a prova do defeito medido em produção.
func TestLogRealSemInfraNosSuspeitos(t *testing.T) {
	caminho := "../var/defesa/acessos.log"
	dados, err := os.ReadFile(caminho)
	if err != nil {
		t.Skipf("log real ausente (%s): %v", caminho, err)
	}
	eventos := make([]evento, 0, 4096)
	for _, linha := range strings.Split(string(dados), "\n") {
		if ev, ok := parseLinha(linha); ok {
			eventos = append(eventos, ev)
		}
	}
	if len(eventos) == 0 {
		t.Skip("log real sem linha parseável")
	}
	lista := calcularSuspeitos(eventos, time.Now(), 0)
	for _, s := range lista {
		if ipInfraLocal(s.IP) {
			t.Fatalf("log real colocou infra local no escore: %s (%d, %v)", s.IP, s.Escore, s.Sinais)
		}
	}
	t.Logf("log real: %d eventos, %d IPs públicos avaliados, 0 infra no escore", len(eventos), len(lista))
}
