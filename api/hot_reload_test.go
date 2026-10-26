package main

// Testes do hot-reload do retrato público (hot_reload.go).
//
// O contrato que estes testes travam, na ordem em que quebra se alguém mexer:
//   1. arquivo novo e VÁLIDO -> o retrato no ar passa a ser o novo (sem app
//      nova, sem reiniciar: só a troca atômica);
//   2. arquivo novo e INVÁLIDO (JSON truncado) -> o retrato no ar NÃO muda e
//      não há panic; o aviso vai para o log;
//   3. leituras concorrentes durante a troca nunca veem ponteiro nulo.
//
// Roda com `go test -race -run HotReload` — público estável com requisição em
// voo é exatamente o que o -race precisa cobrir.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// cenarioHotReload monta um diretório de dados mínimo e válido (publico.json +
// malha_uf.geojson reais, copiados) e devolve o app + o caminho vigiado.
func cenarioHotReload(t *testing.T) (*app, string) {
	t.Helper()

	origem := "../dados"
	destino := t.TempDir()
	for _, nome := range []string{"publico.json", "malha_uf.geojson"} {
		conteudo, err := os.ReadFile(filepath.Join(origem, nome))
		if err != nil {
			t.Fatalf("ler %s de origem: %v", nome, err)
		}
		if err := os.WriteFile(filepath.Join(destino, nome), conteudo, 0o644); err != nil {
			t.Fatalf("escrever %s no temporário: %v", nome, err)
		}
	}

	aplicacao := &app{cfg: config{Eleicao: "6258", Turno: "2", DadosDir: destino}}
	inicial, err := carregarDados(destino, nil)
	if err != nil {
		t.Fatalf("carga inicial: %v", err)
	}
	aplicacao.dadosPtr.Store(inicial)
	return aplicacao, filepath.Join(destino, "publico.json")
}

// publicarNoCaminho escreve o publico.json do jeito que o coletor faz (tmp +
// rename no mesmo diretório) e força mtime distinto do anterior.
func publicarNoCaminho(t *testing.T, caminho string, conteudo []byte) {
	t.Helper()
	temporario := caminho + ".tmp.teste"
	if err := os.WriteFile(temporario, conteudo, 0o644); err != nil {
		t.Fatalf("escrever temporário: %v", err)
	}
	if err := os.Rename(temporario, caminho); err != nil {
		t.Fatalf("rename: %v", err)
	}
	futuro := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(caminho, futuro, futuro); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
}

func TestHotReloadTrocaSemReiniciar(t *testing.T) {
	aplicacao, caminho := cenarioHotReload(t)
	vigiado := assinarArquivo(caminho)

	antes := aplicacao.dados()
	if antes == nil || antes.Publico == nil {
		t.Fatal("retrato inicial nulo")
	}
	nomeAntes := antes.Publico.GeradoEm

	// publico.json novo: mesmo conteúdo, gerado_em diferente (é o que a coleta
	// muda a cada rodada).
	var bruto map[string]any
	conteudo, err := os.ReadFile(caminho)
	if err != nil {
		t.Fatalf("ler publico.json: %v", err)
	}
	if err := json.Unmarshal(conteudo, &bruto); err != nil {
		t.Fatalf("decodificar publico.json: %v", err)
	}
	const nomeDepois = "2026-10-25T22:59:59-03:00"
	bruto["gerado_em"] = nomeDepois
	novoConteudo, err := json.Marshal(bruto)
	if err != nil {
		t.Fatalf("serializar publico.json novo: %v", err)
	}
	publicarNoCaminho(t, caminho, novoConteudo)

	aplicacao.recarregarSeMudou(caminho, &vigiado)

	depois := aplicacao.dados()
	if depois == antes {
		t.Fatal("ponteiro do retrato não trocou: o hot-reload não recarregou")
	}
	if depois.Publico.GeradoEm != nomeDepois {
		t.Fatalf("gerado_em no ar = %q, quer %q", depois.Publico.GeradoEm, nomeDepois)
	}
	if depois.Publico.GeradoEm == nomeAntes {
		t.Fatal("gerado_em não mudou: a api continuaria servindo o snapshot velho")
	}

	// A /api/health lê o mesmo retrato: o gerado_em dela tem de acompanhar.
	if procedencia := aplicacao.procedenciaDoSnapshot(); procedencia.GeradoEm != nomeDepois {
		t.Fatalf("/api/health diria gerado_em = %q, quer %q", procedencia.GeradoEm, nomeDepois)
	}
}

func TestHotReloadArquivoInvalidoMantemRetrato(t *testing.T) {
	aplicacao, caminho := cenarioHotReload(t)
	vigiado := assinarArquivo(caminho)

	antes := aplicacao.dados()
	geradoAntes := antes.Publico.GeradoEm

	// JSON truncado no meio, como sairia de uma escrita interrompida.
	publicarNoCaminho(t, caminho, []byte(`{"gerado_em":"2026-10-25T23:00:00-03:00","ufs":[{"uf":"SP"`))

	aplicacao.recarregarSeMudou(caminho, &vigiado)

	depois := aplicacao.dados()
	if depois != antes {
		t.Fatal("retrato foi trocado por um arquivo inválido: a página ficaria vazia")
	}
	if depois.Publico.GeradoEm != geradoAntes {
		t.Fatalf("gerado_em = %q, quer o anterior %q", depois.Publico.GeradoEm, geradoAntes)
	}
	if len(depois.Publico.UFs) == 0 {
		t.Fatal("retrato no ar ficou sem UF depois da releitura inválida")
	}
}

func TestHotReloadSemMudancaNaoRecarrega(t *testing.T) {
	aplicacao, caminho := cenarioHotReload(t)
	vigiado := assinarArquivo(caminho)

	antes := aplicacao.dados()
	for i := 0; i < 5; i++ {
		aplicacao.recarregarSeMudou(caminho, &vigiado)
	}
	if aplicacao.dados() != antes {
		t.Fatal("retrato trocado sem o arquivo mudar: stat está disparando sozinho")
	}
}

func TestHotReloadLeituraConcorrente(t *testing.T) {
	aplicacao, caminho := cenarioHotReload(t)
	vigiado := assinarArquivo(caminho)

	conteudo, err := os.ReadFile(caminho)
	if err != nil {
		t.Fatalf("ler publico.json: %v", err)
	}

	var nulos atomic.Int64
	var leitores sync.WaitGroup
	parar := make(chan struct{})
	for i := 0; i < 8; i++ {
		leitores.Add(1)
		go func() {
			defer leitores.Done()
			for {
				select {
				case <-parar:
					return
				default:
				}
				estado := aplicacao.dados()
				if estado == nil || estado.Publico == nil || len(estado.Malha.Features) == 0 {
					nulos.Add(1)
				}
			}
		}()
	}

	for i := 0; i < 6; i++ {
		publicarNoCaminho(t, caminho, conteudo)
		aplicacao.recarregarSeMudou(caminho, &vigiado)
	}
	close(parar)
	leitores.Wait()

	if n := nulos.Load(); n != 0 {
		t.Fatalf("%d leituras viram retrato nulo/parcial durante a troca", n)
	}
}
