package main

// Série temporal de acessos para o painel privado: por hora (24 h) e por dia
// (14 dias), sempre separando humano × bot. Sai do MESMO banco da contagem
// anônima (`visitas.db`), sem tabela nova e sem IP em claro — o que existe ali
// é hash do dia + país/estado/cidade.
//
// Uma linha "bot" é a que o filtro de user-agent marcou (bot=1); "humano" é
// todo o resto. Nada é estimado: hora sem visita aparece com barra zero.

import (
	"database/sql"
	"strings"
	"time"
)

const (
	horasSerieAcessos = 24
	diasSerieAcessos  = 14
	topAcessos        = 8
)

// serieAcesso é um ponto do eixo X (uma hora ou um dia).
type serieAcesso struct {
	Chave  string `json:"chave"`  // 2026-10-24T09 (hora) ou 2026-10-24 (dia)
	Rotulo string `json:"rotulo"` // 09h ou 24/10
	Humano int    `json:"humano"`
	Bot    int    `json:"bot"`
	Total  int    `json:"total"`
}

// topAcesso é uma linha de país/cidade.
type topAcesso struct {
	Regiao string `json:"regiao"`
	Humano int    `json:"humano"`
	Bot    int    `json:"bot"`
	Total  int    `json:"total"`
}

// acessosResumo é o bloco que o painel (HTML) e o JSON de métricas consomem.
type acessosResumo struct {
	SerieHora  []serieAcesso `json:"serie_hora"`
	SerieDia   []serieAcesso `json:"serie_dia"`
	PicoHora   serieAcesso   `json:"pico_hora"`
	PicoDia    serieAcesso   `json:"pico_dia"`
	Hoje       serieAcesso   `json:"hoje"`
	TopPaises  []topAcesso   `json:"top_paises"`
	TopCidades []topAcesso   `json:"top_cidades"`
}

// acessos monta a série completa. Erro em qualquer consulta derruba o bloco
// inteiro: série pela metade engana mais do que ajuda.
func (a *anonimo) acessos() (*acessosResumo, error) {
	if a == nil || a.db == nil {
		return nil, nil
	}

	agora := time.Now().In(fusoBrasilia)
	horaAtual := agora.Truncate(time.Hour)
	diaHoje := agora.Format("2006-01-02")

	// O ts é gravado sempre em -03:00, então a comparação textual de datas
	// ISO ordena igual à cronológica.
	corteHora := horaAtual.Add(-time.Duration(horasSerieAcessos-1) * time.Hour).
		Format("2006-01-02T15:00:00-07:00")
	corteDia := agora.AddDate(0, 0, -(diasSerieAcessos - 1)).Format("2006-01-02")

	porHora, err := a.contarPor("substr(ts,1,13)", corteHora)
	if err != nil {
		return nil, err
	}
	porDia, err := a.contarPor("dia", corteDia)
	if err != nil {
		return nil, err
	}

	resumo := &acessosResumo{
		SerieHora:  make([]serieAcesso, 0, horasSerieAcessos),
		SerieDia:   make([]serieAcesso, 0, diasSerieAcessos),
		TopPaises:  []topAcesso{},
		TopCidades: []topAcesso{},
	}

	for i := 0; i < horasSerieAcessos; i++ {
		momento := horaAtual.Add(-time.Duration(horasSerieAcessos-1-i) * time.Hour)
		chave := momento.Format("2006-01-02T15")
		ponto := serieAcesso{Chave: chave, Rotulo: momento.Format("15") + "h"}
		if contagem, existe := porHora[chave]; existe {
			ponto.Humano, ponto.Bot = contagem[0], contagem[1]
			ponto.Total = ponto.Humano + ponto.Bot
		}
		resumo.SerieHora = append(resumo.SerieHora, ponto)
		if ponto.Total > resumo.PicoHora.Total {
			resumo.PicoHora = ponto
		}
	}

	for i := 0; i < diasSerieAcessos; i++ {
		momento := agora.AddDate(0, 0, -(diasSerieAcessos - 1 - i))
		dia := momento.Format("2006-01-02")
		ponto := serieAcesso{Chave: dia, Rotulo: dia[8:10] + "/" + dia[5:7]}
		if contagem, existe := porDia[dia]; existe {
			ponto.Humano, ponto.Bot = contagem[0], contagem[1]
			ponto.Total = ponto.Humano + ponto.Bot
		}
		resumo.SerieDia = append(resumo.SerieDia, ponto)
		if ponto.Total > resumo.PicoDia.Total {
			resumo.PicoDia = ponto
		}
		if dia == diaHoje {
			resumo.Hoje = ponto
		}
	}

	if resumo.TopPaises, err = a.topPor(
		"SELECT COALESCE(NULLIF(pais,''),'?'), SUM(CASE WHEN bot=0 THEN 1 ELSE 0 END), "+
			"SUM(CASE WHEN bot=1 THEN 1 ELSE 0 END) FROM visitas GROUP BY 1", ""); err != nil {
		return nil, err
	}
	if resumo.TopCidades, err = a.topPor(
		"SELECT COALESCE(NULLIF(cidade,''),'?'), COALESCE(NULLIF(uf,''),''), "+
			"SUM(CASE WHEN bot=0 THEN 1 ELSE 0 END), SUM(CASE WHEN bot=1 THEN 1 ELSE 0 END) "+
			"FROM visitas WHERE cidade IS NOT NULL AND cidade <> '' GROUP BY 1,2", "cidade"); err != nil {
		return nil, err
	}

	return resumo, nil
}

// contarPor devolve, por chave (hora ou dia), [humano, bot].
func (a *anonimo) contarPor(campo, desde string) (map[string][2]int, error) {
	consulta := "SELECT " + campo + ", SUM(CASE WHEN bot=0 THEN 1 ELSE 0 END), " +
		"SUM(CASE WHEN bot=1 THEN 1 ELSE 0 END) FROM visitas WHERE " + campo + " >= ? GROUP BY 1"

	linhas, err := a.db.Query(consulta, desde)
	if err != nil {
		return nil, err
	}
	defer linhas.Close()

	saida := make(map[string][2]int, horasSerieAcessos)
	for linhas.Next() {
		var chave sql.NullString
		var humano, bot sql.NullInt64
		if err := linhas.Scan(&chave, &humano, &bot); err != nil {
			return nil, err
		}
		if chave.String == "" {
			continue
		}
		saida[chave.String] = [2]int{int(humano.Int64), int(bot.Int64)}
	}
	return saida, linhas.Err()
}

// topPor lê país (uma coluna) ou cidade+uf (duas colunas). A consulta já vem
// com GROUP BY; aqui só o rótulo e o corte em topAcessos.
func (a *anonimo) topPor(consulta, tipo string) ([]topAcesso, error) {
	linhas, err := a.db.Query(consulta)
	if err != nil {
		return nil, err
	}
	defer linhas.Close()

	candidatos := make([]topAcesso, 0, topAcessos)
	for linhas.Next() {
		var nome, uf sql.NullString
		var humano, bot sql.NullInt64
		if tipo == "cidade" {
			if err := linhas.Scan(&nome, &uf, &humano, &bot); err != nil {
				return nil, err
			}
		} else {
			if err := linhas.Scan(&nome, &humano, &bot); err != nil {
				return nil, err
			}
		}

		regiao := strings.TrimSpace(nome.String)
		if regiao == "" || regiao == "?" {
			regiao = "não identificado"
		}
		if uf.String != "" {
			regiao += " · " + uf.String
		}
		linha := topAcesso{Regiao: regiao, Humano: int(humano.Int64), Bot: int(bot.Int64)}
		linha.Total = linha.Humano + linha.Bot
		candidatos = append(candidatos, linha)
	}
	if err := linhas.Err(); err != nil {
		return nil, err
	}

	// Ordena por total (humano + bot) e corta. Feito em Go porque a consulta de
	// cidade/país já trouxe tudo o que interessa (o banco é pequeno).
	for i := 1; i < len(candidatos); i++ {
		for j := i; j > 0 && candidatos[j].Total > candidatos[j-1].Total; j-- {
			candidatos[j], candidatos[j-1] = candidatos[j-1], candidatos[j]
		}
	}
	if len(candidatos) > topAcessos {
		candidatos = candidatos[:topAcessos]
	}
	return candidatos, nil
}

// pontosDoGrafico converte a série no formato que o gerador de SVG entende.
func pontosDoGrafico(serie []serieAcesso) []pontoGrafico {
	pontos := make([]pontoGrafico, 0, len(serie))
	for _, ponto := range serie {
		pontos = append(pontos, pontoGrafico{Rotulo: ponto.Rotulo, Humano: ponto.Humano, Bot: ponto.Bot})
	}
	return pontos
}
