package main

// Testes da série temporal do painel. Diretório temporário, como o resto dos
// testes de métricas: o banco de produção nunca é tocado.

import (
	"strings"
	"testing"
	"time"
)

func TestAcessosSeriePorHoraEDia(t *testing.T) {
	contagem := anonimoDeTeste(t)
	agora := time.Now()

	// Dois humanos e um robô hoje; um humano ontem.
	for i := 0; i < 2; i++ {
		if _, err := contagem.registrar("189.4.1.1", "Mozilla/5.0 (X11; Linux x86_64) Chrome/120", agora); err != nil {
			t.Fatalf("registrar humano %d: %v", i+1, err)
		}
	}
	if _, err := contagem.registrar("189.4.1.2", "Googlebot/2.1", agora); err != nil {
		t.Fatalf("registrar bot: %v", err)
	}
	if _, err := contagem.registrar("189.4.1.3", "Mozilla/5.0 Chrome/120", agora.AddDate(0, 0, -1)); err != nil {
		t.Fatalf("registrar ontem: %v", err)
	}

	acessos, err := contagem.acessos()
	if err != nil {
		t.Fatalf("acessos: %v", err)
	}
	if acessos == nil {
		t.Fatal("acessos voltou nil")
	}

	if len(acessos.SerieHora) != horasSerieAcessos {
		t.Errorf("serie_hora tem %d pontos, quer %d", len(acessos.SerieHora), horasSerieAcessos)
	}
	if len(acessos.SerieDia) != diasSerieAcessos {
		t.Errorf("serie_dia tem %d pontos, quer %d", len(acessos.SerieDia), diasSerieAcessos)
	}

	// O último balde de hora é a hora atual: 2 humanos + 1 bot.
	ultima := acessos.SerieHora[len(acessos.SerieHora)-1]
	if ultima.Humano != 2 || ultima.Bot != 1 || ultima.Total != 3 {
		t.Errorf("hora atual = humano %d bot %d total %d, quer 2/1/3", ultima.Humano, ultima.Bot, ultima.Total)
	}

	// Hoje: 2 humanos + 1 bot; ontem: 1 humano.
	if acessos.Hoje.Humano != 2 || acessos.Hoje.Bot != 1 {
		t.Errorf("hoje = humano %d bot %d, quer 2/1", acessos.Hoje.Humano, acessos.Hoje.Bot)
	}
	ontem := acessos.SerieDia[len(acessos.SerieDia)-2]
	if ontem.Humano != 1 || ontem.Bot != 0 {
		t.Errorf("ontem = humano %d bot %d, quer 1/0", ontem.Humano, ontem.Bot)
	}

	// Pico do dia é hoje (3) e pico da hora é a hora atual (3).
	if acessos.PicoDia.Total != 3 {
		t.Errorf("pico do dia = %d, quer 3", acessos.PicoDia.Total)
	}
	if acessos.PicoHora.Total != 3 {
		t.Errorf("pico da hora = %d, quer 3", acessos.PicoHora.Total)
	}

	// Hora sem visita existe e vem zerada (não é buraco na série).
	vazias := 0
	for _, ponto := range acessos.SerieHora {
		if ponto.Total == 0 {
			vazias++
		}
	}
	if vazias == 0 {
		t.Error("nenhuma hora zerada na série: os baldes vazios não foram preenchidos")
	}
}

func TestAcessosGraficoNoPainel(t *testing.T) {
	contagem := anonimoDeTeste(t)
	if _, err := contagem.registrar("189.4.1.1", "Mozilla/5.0 Chrome/120", time.Now()); err != nil {
		t.Fatalf("registrar: %v", err)
	}
	acessos, err := contagem.acessos()
	if err != nil {
		t.Fatalf("acessos: %v", err)
	}

	painel := montarPainelMetricas(montagemPainel{
		GeradoEm: "2026-10-24T10:00:00-03:00",
		Classes:  map[string]uint64{},
		Anonimo:  nil,
		Acessos:  acessos,
		Defesa:   estadoDefesa{Disponivel: false, Motivo: "vigia não configurado (estado ausente)"},
	})

	for _, esperado := range []string{
		"Acessos por hora", "Acessos por dia", "Total do dia e picos",
		"Top países", "Top cidades", "<svg", "Defesa (bloqueios)",
	} {
		if !strings.Contains(painel, esperado) {
			t.Errorf("painel sem %q", esperado)
		}
	}
	// Sem CDN e sem script: o painel é um documento só.
	for _, proibido := range []string{"<script", "https://", "http://"} {
		if strings.Contains(painel, proibido) {
			t.Errorf("painel contém %q (deveria ser self-contained)", proibido)
		}
	}
}

func TestEstadoDefesaAusenteNaoQuebraPainel(t *testing.T) {
	t.Setenv("DEFESA_ESTADO", t.TempDir()+"/nao-existe.json")
	estado := lerEstadoDefesa()
	if estado.Disponivel {
		t.Fatal("estado ausente marcado como disponível")
	}
	if estado.Motivo == "" {
		t.Error("estado ausente sem motivo")
	}
}
