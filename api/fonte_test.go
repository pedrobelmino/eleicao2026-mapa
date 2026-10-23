package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	baseFonteTeste   = "https://resultados.tse.jus.br/oficial/ele2026"
	portalFonteTeste = "https://resultados.tse.jus.br/"
)

func configFonteValidaTeste() config {
	return config{
		Eleicao:   "6258",
		Turno:     "2",
		TSEBase:   baseFonteTeste,
		TSEPortal: portalFonteTeste,
	}
}

func TestFonteNovaFonteSegundoTurno(t *testing.T) {
	obtida, err := novaFonte(configFonteValidaTeste())
	if err != nil {
		t.Fatalf("novaFonte com configuração válida: %v", err)
	}

	if obtida.Eleicao != "6258" {
		t.Errorf("Eleicao = %q, quer %q", obtida.Eleicao, "6258")
	}
	if obtida.Turno != "2" {
		t.Errorf("Turno = %q, quer %q", obtida.Turno, "2")
	}
	if obtida.Rotulo != "2º turno" {
		t.Errorf("Rotulo = %q, quer %q", obtida.Rotulo, "2º turno")
	}
	if obtida.Base != baseFonteTeste {
		t.Errorf("Base = %q, quer %q", obtida.Base, baseFonteTeste)
	}
	if obtida.Portal != "https://resultados.tse.jus.br" {
		t.Errorf("Portal = %q, quer sem barra final", obtida.Portal)
	}

	querNacional := baseFonteTeste + "/6258/dados/br/br-c0001-e006258-u.json"
	if obtida.Nacional != querNacional {
		t.Errorf("Nacional = %q, quer %q", obtida.Nacional, querNacional)
	}
}

func TestFonteNovaFonteNormalizaEspacosEBarras(t *testing.T) {
	cfg := config{
		Eleicao:   " 6258 ",
		Turno:     " 2 ",
		TSEBase:   baseFonteTeste + "/",
		TSEPortal: portalFonteTeste,
	}

	obtida, err := novaFonte(cfg)
	if err != nil {
		t.Fatalf("novaFonte com espaços e barra final: %v", err)
	}
	if obtida.Eleicao != "6258" {
		t.Errorf("Eleicao = %q, quer %q", obtida.Eleicao, "6258")
	}
	if obtida.Turno != "2" {
		t.Errorf("Turno = %q, quer %q", obtida.Turno, "2")
	}
	if strings.HasSuffix(obtida.Base, "/") {
		t.Errorf("Base = %q, não deveria terminar em barra", obtida.Base)
	}
	if strings.HasSuffix(obtida.Portal, "/") {
		t.Errorf("Portal = %q, não deveria terminar em barra", obtida.Portal)
	}
}

func TestFonteURLCodigoComZerosEsquerda(t *testing.T) {
	cfg := configFonteValidaTeste()
	cfg.Eleicao = "06257"
	cfg.Turno = "1"

	obtida, err := novaFonte(cfg)
	if err != nil {
		t.Fatalf("novaFonte com zero à esquerda: %v", err)
	}

	querNacional := baseFonteTeste + "/6257/dados/br/br-c0001-e006257-u.json"
	if obtida.Nacional != querNacional {
		t.Errorf("Nacional = %q, quer %q", obtida.Nacional, querNacional)
	}
}

func TestFonteNovaFonteRejeitaConfiguracaoInvalida(t *testing.T) {
	casos := []struct {
		nome    string
		ajustar func(*config)
		trecho  string
	}{
		{
			nome:    "eleicao com letra",
			ajustar: func(cfg *config) { cfg.Eleicao = "62a7" },
			trecho:  "ELEICAO inválida",
		},
		{
			nome:    "eleicao vazia",
			ajustar: func(cfg *config) { cfg.Eleicao = "" },
			trecho:  "ELEICAO inválida",
		},
		{
			nome:    "eleicao curta",
			ajustar: func(cfg *config) { cfg.Eleicao = "123" },
			trecho:  "ELEICAO inválida",
		},
		{
			nome:    "turno fora de 1 e 2",
			ajustar: func(cfg *config) { cfg.Turno = "3" },
			trecho:  "TURNO inválido",
		},
		{
			nome:    "turno vazio",
			ajustar: func(cfg *config) { cfg.Turno = "" },
			trecho:  "TURNO inválido",
		},
		{
			nome:    "base ftp",
			ajustar: func(cfg *config) { cfg.TSEBase = "ftp://x" },
			trecho:  "TSE_BASE inválida",
		},
		{
			nome:    "base nao e url",
			ajustar: func(cfg *config) { cfg.TSEBase = "nao-e-url" },
			trecho:  "TSE_BASE inválida",
		},
		{
			nome:    "base com query",
			ajustar: func(cfg *config) { cfg.TSEBase = baseFonteTeste + "?a=1" },
			trecho:  "TSE_BASE inválida",
		},
		{
			nome:    "base com fragmento",
			ajustar: func(cfg *config) { cfg.TSEBase = baseFonteTeste + "#frag" },
			trecho:  "TSE_BASE inválida",
		},
		{
			nome:    "portal ftp",
			ajustar: func(cfg *config) { cfg.TSEPortal = "ftp://x" },
			trecho:  "TSE_PORTAL inválida",
		},
		{
			nome:    "portal com query",
			ajustar: func(cfg *config) { cfg.TSEPortal = portalFonteTeste + "?a=1" },
			trecho:  "TSE_PORTAL inválida",
		},
	}

	for _, caso := range casos {
		t.Run(caso.nome, func(t *testing.T) {
			cfg := configFonteValidaTeste()
			caso.ajustar(&cfg)

			_, err := novaFonte(cfg)
			if err == nil {
				t.Fatalf("novaFonte aceitou configuração inválida")
			}
			if !strings.Contains(err.Error(), caso.trecho) {
				t.Errorf("erro = %q, quer conter %q", err.Error(), caso.trecho)
			}
		})
	}
}

func TestFonteURLsPorUF(t *testing.T) {
	obtida, err := novaFonte(configFonteValidaTeste())
	if err != nil {
		t.Fatalf("novaFonte: %v", err)
	}

	querUF := baseFonteTeste + "/6258/dados/ce/ce-c0001-e006258-u.json"
	if url := obtida.URLUF("ce"); url != querUF {
		t.Errorf("URLUF(%q) = %q, quer %q", "ce", url, querUF)
	}
	if url := obtida.URLUF("CE"); url != querUF {
		t.Errorf("URLUF(%q) = %q, quer %q", "CE", url, querUF)
	}
	if url := obtida.URLUF("cE"); url != querUF {
		t.Errorf("URLUF(%q) = %q, quer %q", "cE", url, querUF)
	}

	querFotos := baseFonteTeste + "/6258/fotos/ce/"
	if url := obtida.URLFotos("ce"); url != querFotos {
		t.Errorf("URLFotos(%q) = %q, quer %q", "ce", url, querFotos)
	}
	if url := obtida.URLFotos("CE"); url != querFotos {
		t.Errorf("URLFotos(%q) = %q, quer %q", "CE", url, querFotos)
	}

	invalidas := []string{"", "c", "cee", "c1", "1c", "ÇE", " ce"}
	for _, uf := range invalidas {
		if url := obtida.URLUF(uf); url != "" {
			t.Errorf("URLUF(%q) = %q, quer vazio", uf, url)
		}
		if url := obtida.URLFotos(uf); url != "" {
			t.Errorf("URLFotos(%q) = %q, quer vazio", uf, url)
		}
	}
}

func TestFonteVerificar(t *testing.T) {
	casos := []struct {
		nome     string
		status   int
		corpo    string
		querOK   bool
		querErro string
	}{
		{
			nome:   "json objeto",
			status: http.StatusOK,
			corpo:  `{"ok":true}`,
			querOK: true,
		},
		{
			nome:   "json array",
			status: http.StatusOK,
			corpo:  `[{"ok":true}]`,
			querOK: true,
		},
		{
			nome:     "http 500",
			status:   http.StatusInternalServerError,
			corpo:    `{"erro":"falha"}`,
			querErro: "HTTP 500",
		},
		{
			nome:     "html",
			status:   http.StatusOK,
			corpo:    "<html>",
			querErro: "não é JSON",
		},
		{
			nome:     "json escalar",
			status:   http.StatusOK,
			corpo:    `"texto"`,
			querErro: "não é JSON",
		},
	}

	for _, caso := range casos {
		t.Run(caso.nome, func(t *testing.T) {
			servidor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Errorf("método = %q, quer GET", r.Method)
				}
				if aceito := r.Header.Get("Accept"); aceito != "application/json" {
					t.Errorf("Accept = %q, quer %q", aceito, "application/json")
				}
				if agente := r.Header.Get("User-Agent"); agente != agenteFonte {
					t.Errorf("User-Agent = %q, quer %q", agente, agenteFonte)
				}

				w.WriteHeader(caso.status)
				_, _ = w.Write([]byte(caso.corpo))
			}))
			defer servidor.Close()

			origem := fonte{Nacional: servidor.URL + "/6258/dados/br/br-c0001-e006258-u.json"}
			verificacao := origem.verificar(context.Background(), servidor.Client())

			if verificacao.URL != origem.Nacional {
				t.Errorf("URL = %q, quer %q", verificacao.URL, origem.Nacional)
			}
			if verificacao.OK != caso.querOK {
				t.Errorf("OK = %v, quer %v (erro: %q)", verificacao.OK, caso.querOK, verificacao.Erro)
			}
			if verificacao.Status != caso.status {
				t.Errorf("Status = %d, quer %d", verificacao.Status, caso.status)
			}
			if caso.querErro == "" {
				if verificacao.Erro != "" {
					t.Errorf("Erro = %q, quer vazio", verificacao.Erro)
				}
			} else if !strings.Contains(verificacao.Erro, caso.querErro) {
				t.Errorf("Erro = %q, quer conter %q", verificacao.Erro, caso.querErro)
			}
			if verificacao.VerificadoEm == "" {
				t.Error("VerificadoEm vazio")
			} else if _, err := time.Parse(time.RFC3339, verificacao.VerificadoEm); err != nil {
				t.Errorf("VerificadoEm = %q não está em RFC3339: %v", verificacao.VerificadoEm, err)
			}
			if verificacao.DuracaoMs < 0 {
				t.Errorf("DuracaoMs = %d, quer >= 0", verificacao.DuracaoMs)
			}
		})
	}
}

func TestFonteVerificarPortaFechada(t *testing.T) {
	servidor := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	endereco := servidor.URL
	servidor.Close()

	origem := fonte{Nacional: endereco + "/6258/dados/br/br-c0001-e006258-u.json"}
	inicio := time.Now()
	verificacao := origem.verificar(context.Background(), nil)
	decorrido := time.Since(inicio)

	if verificacao.OK {
		t.Fatalf("OK = true para porta fechada")
	}
	if !strings.Contains(verificacao.Erro, "inacessível") {
		t.Errorf("Erro = %q, quer conter %q", verificacao.Erro, "inacessível")
	}
	if verificacao.Status != 0 {
		t.Errorf("Status = %d, quer 0", verificacao.Status)
	}
	if decorrido >= 5*time.Second {
		t.Errorf("verificação demorou %v, quer menos de 5s", decorrido)
	}
}
