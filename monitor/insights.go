package main

// Insights automáticos: frases curtas geradas por REGRA, nunca por LLM.
// Cada regra é uma pergunta objetiva sobre o snapshot; se a resposta não existe
// (sem dado), a regra não fala — melhor calar que inventar.
//
// A ordem é por importância: alerta primeiro, "tudo calmo" por último.

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// referencias são os números que só fazem sentido fora do snapshot (média
// histórica, instante do último ataque). Calculados junto com a varredura.
type referencias struct {
	taxaAnterior float64
	temTaxa      bool
	ultimoAtaque time.Time
	temAtaque    bool
}

func gerarInsights(snap *snapshot, refs referencias) []insight {
	saida := make([]insight, 0, 8)

	cinco := snap.Janelas["5m"]
	hora := snap.Janelas["1h"]

	// 1) Pico: taxa dos últimos 5 min contra a média dos 25 min anteriores.
	if refs.temTaxa && refs.taxaAnterior > 0.02 {
		razao := cinco.ReqS / refs.taxaAnterior
		if razao >= 3 && cinco.Total >= 20 {
			saida = append(saida, insight{
				Nivel: "alerta",
				Texto: fmt.Sprintf("pico %.1fx acima da média dos últimos 25 min (%.1f req/s contra %.1f req/s)",
					razao, cinco.ReqS, refs.taxaAnterior),
			})
		} else if razao >= 1.8 && cinco.Total >= 20 {
			saida = append(saida, insight{
				Nivel: "atencao",
				Texto: fmt.Sprintf("tráfego %.1fx acima da média dos últimos 25 min", razao),
			})
		}
	}

	// 2) IP insistindo em caminho sensível (o formato do scanner automático).
	for _, reg := range cinco.AtaquesReg {
		if reg.N >= 8 && (reg.Tipo == AtaqueSensivel || reg.Tipo == AtaqueTraversal || reg.Tipo == AtaqueScanner) {
			saida = append(saida, insight{
				Nivel: "alerta",
				Texto: fmt.Sprintf("%s (%s) tentou %d caminhos de %s em 5 min — último: %s",
					reg.IP, reg.Host, reg.N, reg.Tipo, reg.Caminho),
			})
			break
		}
	}

	// 3) Flood / rate limit.
	if n := cinco.AtaqueTipo[AtaqueFlood]; n > 0 {
		saida = append(saida, insight{
			Nivel: "alerta",
			Texto: fmt.Sprintf("%d registro(s) de flood/429 em 5 min — %d IP(s) afetados, site continua no ar",
				n, cinco.Bloqueados),
		})
	}

	// 4) Erro de backend.
	if cinco.PorClasse["5xx"] > 0 {
		saida = append(saida, insight{
			Nivel: "alerta",
			Texto: fmt.Sprintf("%d resposta(s) 5xx em 5 min — erro no backend, não é ataque",
				cinco.PorClasse["5xx"]),
		})
	}

	// 5) Último ataque: silêncio também é informação.
	if refs.temAtaque {
		desde := time.Since(refs.ultimoAtaque)
		if desde > time.Hour {
			saida = append(saida, insight{
				Nivel: "ok",
				Texto: fmt.Sprintf("nenhum ataque há %s (último às %s)",
					duracaoCurta(desde), refs.ultimoAtaque.In(time.Local).Format("15:04")),
			})
		}
	} else if snap.Lidos > 0 {
		saida = append(saida, insight{Nivel: "ok", Texto: "nenhum ataque desde o início da coleta"})
	}

	// 6) Bots.
	if cinco.BotsAtivos > 0 {
		saida = append(saida, insight{
			Nivel: "info",
			Texto: fmt.Sprintf("%d bot(s) ativo(s) nos últimos 5 min; %d humano(s) na última hora",
				cinco.BotsAtivos, hora.Unicos["hora"]),
		})
	} else if hora.Total > 0 {
		saida = append(saida, insight{
			Nivel: "info",
			Texto: fmt.Sprintf("nenhum bot nos últimos 5 min; %d visitante(s) humano(s) na última hora",
				hora.Unicos["hora"]),
		})
	}

	// 7) Concentração por host: o pedido é separar o que entra por cada domínio.
	if len(hora.Hosts) > 0 && hora.Total > 0 {
		principal := hora.Hosts[0]
		pct := 100 * float64(principal.Total) / float64(hora.Total)
		rotulo := principal.Host
		if rotulo == hospedeiroDesconhecido {
			rotulo = "host não registrado (linhas antigas do log)"
		}
		saida = append(saida, insight{
			Nivel: "info",
			Texto: fmt.Sprintf("%s concentra %.0f%% do tráfego da última hora (%d req)",
				rotulo, pct, principal.Total),
		})
	}

	// 8) Proporção humano × bot.
	if hora.Total >= 10 {
		pct := 100 * float64(hora.Humano) / float64(hora.Total)
		nivel := "info"
		if pct < 30 {
			nivel = "atencao"
		}
		saida = append(saida, insight{
			Nivel: nivel,
			Texto: fmt.Sprintf("tráfego da última hora: %.0f%% humano · %.0f%% bot · %.0f%% ataque",
				pct, 100*float64(hora.Bot)/float64(hora.Total), 100*float64(hora.Ataques)/float64(hora.Total)),
		})
	}

	// 9) IPs bloqueados pelo vigia.
	if snap.Vigia != nil {
		if ativos, ok := snap.Vigia["bloqueios_ativos"].(int); ok && ativos > 0 {
			saida = append(saida, insight{
				Nivel: "atencao",
				Texto: fmt.Sprintf("%d IP(s) bloqueados na borda pelo vigia agora", ativos),
			})
		}
	}

	// 9b) Suspeitos por escore. Não é bloqueio: o painel avisa e o bloqueio é
	// decisão manual (bloquear.sh). O visitante que fica conectado não entra
	// aqui, porque volume nenhum pontua.
	if len(snap.Suspeitos) > 0 {
		maliciosos, suspeitos := 0, 0
		for _, s := range snap.Suspeitos {
			switch s.Nivel {
			case NivelMalicioso:
				maliciosos++
			case NivelSuspeito:
				suspeitos++
			}
		}
		if maliciosos > 0 {
			primeiro := snap.Suspeitos[0]
			saida = append(saida, insight{
				Nivel: "alerta",
				Texto: fmt.Sprintf("%d IP(s) malicioso(s) e %d suspeito(s) por escore — o maior é %s com %d/100 (%s)",
					maliciosos, suspeitos, primeiro.IP, primeiro.Escore, strings.Join(primeiro.Rotulos, ", ")),
			})
		} else if suspeitos > 0 {
			saida = append(saida, insight{
				Nivel: "atencao",
				Texto: fmt.Sprintf("%d IP(s) em observação/suspeita por escore; nenhum malicioso agora", suspeitos),
			})
		}
	}

	if snap.Parcial24h {
		saida = append(saida, insight{
			Nivel: "info",
			Texto: "janela de 24 h parcial: o log é truncado em 5 MB pelo vigia, o painel mostra o que ainda está no arquivo",
		})
	}

	// Alerta primeiro; dentro do mesmo nível, maior texto? não: ordem estável.
	peso := map[string]int{"alerta": 0, "atencao": 1, "ok": 2, "info": 3}
	sort.SliceStable(saida, func(a, b int) bool { return peso[saida[a].Nivel] < peso[saida[b].Nivel] })
	return saida
}

// taxaAnterior devolve req/s da faixa [agora-25min-janela, agora-25min] — a
// referência do "pico 3x acima da média", sem contaminar com o próprio pico.
// NÃO trava: chamada de dentro de foto(), que já segura c.mu.RLock.
func (c *coletor) taxaAnterior(recuo time.Duration) (float64, bool) {
	agora := time.Now()
	fim := agora.Add(-recuo)
	inicio := fim.Add(-25 * time.Minute)

	contagem := 0
	for i := range c.eventos {
		quando := c.eventos[i].Quando
		if quando.After(inicio) && !quando.After(fim) {
			contagem++
		}
	}
	if len(c.eventos) == 0 {
		return 0, false
	}
	coberto := agora.Sub(c.eventos[0].Quando)
	if coberto < 30*time.Minute {
		return 0, false
	}
	return float64(contagem) / (25 * 60), true
}

func (c *coletor) ultimoAtaque() (time.Time, bool) {
	for i := len(c.eventos) - 1; i >= 0; i-- {
		if c.eventos[i].Ataque != "" {
			return c.eventos[i].Quando, true
		}
	}
	return time.Time{}, false
}

func duracaoCurta(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%d s", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%d min", int(d.Minutes()))
	}
	horas := int(d.Hours())
	if horas < 24 {
		return fmt.Sprintf("%dh%02d", horas, int(d.Minutes())%60)
	}
	return fmt.Sprintf("%d dias", horas/24)
}
