package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// descarte é um ResponseWriter que só conta bytes: isola o custo do handler do
// custo de copiar 3 MB para um httptest.ResponseRecorder.
type descarte struct {
	cabecalho http.Header
	escritos  int
}

func (d *descarte) Header() http.Header {
	if d.cabecalho == nil {
		d.cabecalho = http.Header{}
	}
	return d.cabecalho
}

func (d *descarte) Write(conteudo []byte) (int, error) {
	d.escritos += len(conteudo)
	return len(conteudo), nil
}

func (d *descarte) WriteHeader(int) {}

func appDeBenchmark(b *testing.B) *app {
	b.Helper()
	b.Setenv("DADOS_DIR", "../dados")
	aplicacao, err := novaApp(carregarConfig())
	if err != nil {
		b.Fatalf("criar aplicação com os dados reais: %v", err)
	}
	return aplicacao
}

// BenchmarkSerie2022 mede o custo de servir /api/serie2022. Com o cache de
// bytes, o caso quente é só a escrita; o caso frio continua sendo lido quando
// o arquivo muda.
func BenchmarkSerie2022(b *testing.B) {
	aplicacao := appDeBenchmark(b)
	requisicao := httptest.NewRequest(http.MethodGet, "/api/serie2022", nil)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		escritor := &descarte{}
		aplicacao.handleSerie2022(escritor, requisicao)
		if escritor.escritos == 0 {
			b.Fatal("handler não escreveu corpo")
		}
	}
}

// BenchmarkSerie2022Frio mede a remontagem do payload a partir do arquivo
// (cache invalidado a cada iteração).
func BenchmarkSerie2022Frio(b *testing.B) {
	aplicacao := appDeBenchmark(b)
	requisicao := httptest.NewRequest(http.MethodGet, "/api/serie2022", nil)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		aplicacao.invalidarCacheSerie2022()
		escritor := &descarte{}
		aplicacao.handleSerie2022(escritor, requisicao)
	}
}
