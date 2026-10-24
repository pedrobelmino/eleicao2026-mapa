package main

// Leitura do estado do vigia de ataques para o painel privado.
//
// O vigia (scripts/defesa/vigia_ataques.py) é quem bloqueia; ele escreve
// `<var/defesa>/estado.json` no host, montado aqui como leitura. Este arquivo
// só LÊ — o painel nunca altera a defesa. Arquivo ausente/ilegível não é erro:
// vira "vigia não configurado" na tela.

import (
	"encoding/json"
	"os"
	"sort"
	"time"
)

const limiteEstadoDefesa = 1 << 20 // 1 MB: estado de defesa é pequeno

type bloqueioDefesa struct {
	IP       string `json:"ip"`
	Motivo   string `json:"motivo"`
	Detalhe  string `json:"detalhe"`
	Desde    string `json:"desde"`
	Ate      string `json:"ate"`
	Contagem int    `json:"contagem"`
}

type estadoDefesa struct {
	Disponivel bool
	Motivo     string // por que não está disponível (quando for o caso)
	Caminho    string
	Bloqueios  []bloqueioDefesa
	Total      int
	Execucao   string
}

type estadoDefesaArquivo struct {
	Bloqueios map[string]struct {
		Motivo   string `json:"motivo"`
		Detalhe  string `json:"detalhe"`
		Desde    string `json:"desde"`
		Ate      string `json:"ate"`
		Contagem int    `json:"contagem"`
	} `json:"bloqueios"`
	TotalBloqueios int    `json:"total_bloqueios"`
	UltimaExecucao string `json:"ultima_execucao"`
}

func lerEstadoDefesa() estadoDefesa {
	caminho := envOu("DEFESA_ESTADO", "/defesa/estado.json")
	estado := estadoDefesa{Caminho: caminho}

	info, err := os.Stat(caminho)
	if err != nil {
		estado.Motivo = "vigia não configurado (estado ausente)"
		return estado
	}
	if info.Size() > limiteEstadoDefesa {
		estado.Motivo = "estado grande demais para leitura"
		return estado
	}

	conteudo, err := os.ReadFile(caminho)
	if err != nil {
		estado.Motivo = "estado ilegível"
		return estado
	}

	var arquivo estadoDefesaArquivo
	if err := json.Unmarshal(conteudo, &arquivo); err != nil {
		estado.Motivo = "estado inválido"
		return estado
	}

	estado.Disponivel = true
	estado.Total = arquivo.TotalBloqueios
	estado.Execucao = arquivo.UltimaExecucao

	estado.Bloqueios = make([]bloqueioDefesa, 0, len(arquivo.Bloqueios))
	for ip, registro := range arquivo.Bloqueios {
		estado.Bloqueios = append(estado.Bloqueios, bloqueioDefesa{
			IP:       ip,
			Motivo:   registro.Motivo,
			Detalhe:  registro.Detalhe,
			Desde:    registro.Desde,
			Ate:      registro.Ate,
			Contagem: registro.Contagem,
		})
	}
	sort.Slice(estado.Bloqueios, func(i, j int) bool {
		return estado.Bloqueios[i].Ate < estado.Bloqueios[j].Ate
	})

	return estado
}

// horaLegivel corta o ISO do estado para HH:MM (o painel é de plantão).
func horaLegivel(valor string) string {
	if momento, err := time.Parse(time.RFC3339, valor); err == nil {
		return momento.In(fusoBrasilia).Format("02/01 15:04")
	}
	if len(valor) >= 16 {
		return valor[11:16]
	}
	return valor
}
