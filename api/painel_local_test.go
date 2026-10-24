package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestAcessoLocalPainel cobre a exceção local das rotas internas: o proxy do
// server block 8081 marca a requisição e só conexões de par privado passam.
// Um cabeçalho forjado pelo cliente, vindo de par público, nunca libera nada.
func TestAcessoLocalPainel(t *testing.T) {
	aplicacao := novaAppDeTeste(t)
	caminhos := []string{"/api/interno/metricas", "/api/interno/painel"}

	executar := func(t *testing.T, caminho, remoteAddr string, cabecalhos map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		requisicao := httptest.NewRequest(http.MethodGet, caminho, nil)
		requisicao.RemoteAddr = remoteAddr
		for nome, valor := range cabecalhos {
			requisicao.Header.Set(nome, valor)
		}
		resposta := httptest.NewRecorder()
		aplicacao.handler().ServeHTTP(resposta, requisicao)
		return resposta
	}

	for _, token := range []string{"", "token-de-teste-com-32-caracteres-ok"} {
		nome := "token-vazio"
		if token != "" {
			nome = "token-configurado"
		}
		t.Run("local-dispensa-"+nome, func(t *testing.T) {
			t.Setenv("METRICAS_TOKEN", token)
			for _, caminho := range caminhos {
				resposta := executar(t, caminho, "172.17.0.1:5555", map[string]string{
					"X-Painel-Local": "1",
				})
				if resposta.Code != http.StatusOK {
					t.Fatalf("%s com marca local e %s: status = %d, quer 200 (corpo %q)",
						caminho, nome, resposta.Code, resposta.Body.String())
				}
				if valor := resposta.Header().Get("Cache-Control"); valor != "no-store" {
					t.Errorf("%s: Cache-Control = %q, quer no-store", caminho, valor)
				}
				if valor := resposta.Header().Get("X-Robots-Tag"); valor != "noindex, nofollow" {
					t.Errorf("%s: X-Robots-Tag = %q, quer noindex, nofollow", caminho, valor)
				}
			}
		})
	}

	t.Run("cabecalho-de-cliente-em-par-publico-nao-libera", func(t *testing.T) {
		t.Setenv("METRICAS_TOKEN", "token-de-teste-com-32-caracteres-ok")
		for _, caminho := range caminhos {
			resposta := executar(t, caminho, "189.4.1.1:5555", map[string]string{
				"X-Real-IP":       "127.0.0.1",
				"X-Forwarded-For": "127.0.0.1",
				"X-Painel-Local":  "1",
			})
			if resposta.Code != http.StatusUnauthorized {
				t.Fatalf("%s com cabeçalhos forjados de par público: status = %d, quer 401 (nunca 200)",
					caminho, resposta.Code)
			}
		}
	})

	t.Run("sem-marca-em-par-privado-nao-libera", func(t *testing.T) {
		t.Setenv("METRICAS_TOKEN", "token-de-teste-com-32-caracteres-ok")
		for _, caminho := range caminhos {
			resposta := executar(t, caminho, "172.17.0.1:5555", map[string]string{
				"X-Real-IP":       "127.0.0.1",
				"X-Forwarded-For": "127.0.0.1",
			})
			if resposta.Code != http.StatusUnauthorized {
				t.Fatalf("%s sem marca do proxy: status = %d, quer 401", caminho, resposta.Code)
			}
		}
	})

	t.Run("marca-com-valor-errado-nao-libera", func(t *testing.T) {
		t.Setenv("METRICAS_TOKEN", "token-de-teste-com-32-caracteres-ok")
		for _, marca := range []string{"true", "1 ", "0"} {
			for _, caminho := range caminhos {
				resposta := executar(t, caminho, "172.17.0.1:5555", map[string]string{
					"X-Painel-Local": marca,
				})
				if resposta.Code != http.StatusUnauthorized && resposta.Code != http.StatusForbidden {
					t.Fatalf("%s com marca %q: status = %d, quer 401 ou 403 (nunca 200)",
						caminho, marca, resposta.Code)
				}
			}
		}
	})

	t.Run("token-valido-de-par-publico-continua-valendo", func(t *testing.T) {
		t.Setenv("METRICAS_TOKEN", "token-de-teste-com-32-caracteres-ok")
		for _, caminho := range caminhos {
			resposta := executar(t, caminho, "189.4.1.1:5555", map[string]string{
				"X-Metricas-Token": "token-de-teste-com-32-caracteres-ok",
			})
			if resposta.Code != http.StatusOK {
				t.Fatalf("%s com token válido de par público: status = %d, quer 200 (corpo %q)",
					caminho, resposta.Code, resposta.Body.String())
			}
		}
	})
}
