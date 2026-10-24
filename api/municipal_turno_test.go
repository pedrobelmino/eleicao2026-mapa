package main

import (
	"strings"
	"testing"
)

// TestProcedenciaMunicipal cobre a única coisa que impede o defeito grave do
// projeto: mostrar voto municipal do 1º turno com o painel no 2º turno sem
// dizer que o dado é de outro turno.
func TestProcedenciaMunicipal(t *testing.T) {
	municipal := func(eleicao, turno string) *dadosUF {
		return &dadosUF{Municipios: municipiosResposta{
			UF: "CE", Eleicao: eleicao, Turno: turno, GeradoEm: "2026-10-06T14:03:43-03:00",
		}}
	}

	casos := []struct {
		nome        string
		eleicaoApp  string
		municipais  map[string]*dadosUF
		queroAviso  bool
		queroTrecho []string
	}{
		{
			nome:       "turno em exibição igual ao do arquivo: sem aviso",
			eleicaoApp: "6257",
			municipais: map[string]*dadosUF{"CE": municipal("6257", "1")},
			queroAviso: false,
		},
		{
			nome:       "painel no 2º turno, arquivo do 1º: avisa com todas as letras",
			eleicaoApp: "6258",
			municipais: map[string]*dadosUF{"CE": municipal("6257", "1")},
			queroAviso: true,
			queroTrecho: []string{
				"1º turno", "eleição 6257", "só ao final de cada turno",
			},
		},
		{
			nome:       "sem arquivo municipal: diz que está fora do ar",
			eleicaoApp: "6258",
			municipais: map[string]*dadosUF{},
			queroAviso: true,
			queroTrecho: []string{"sem dado municipal carregado"},
		},
		{
			nome:       "UF divergente no meio: avisa a divergência",
			eleicaoApp: "6258",
			municipais: map[string]*dadosUF{
				"CE": municipal("6257", "1"),
				"SP": municipal("6258", "2"),
			},
			queroAviso:  true,
			queroTrecho: []string{"1º turno", "1 UF(s) com eleição diferente"},
		},
	}

	for _, caso := range casos {
		t.Run(caso.nome, func(t *testing.T) {
			a := &app{cfg: config{Eleicao: caso.eleicaoApp, Turno: "2"}, municipais: caso.municipais}
			p := a.procedenciaDoMunicipal()
			if caso.queroAviso && p.Aviso == "" {
				t.Fatalf("esperava aviso, veio vazio (procedencia=%+v)", p)
			}
			if !caso.queroAviso && p.Aviso != "" {
				t.Fatalf("não esperava aviso, veio %q", p.Aviso)
			}
			for _, trecho := range caso.queroTrecho {
				if !strings.Contains(p.Aviso, trecho) {
					t.Fatalf("aviso sem %q: %q", trecho, p.Aviso)
				}
			}
		})
	}
}
