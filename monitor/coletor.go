package main

// Coletor: guarda os eventos em memória (ring), calcula as janelas de 5 min,
// 1 h e 24 h por varredura e persiste só o agregado diário — o IP aparece em
// memória e no detalhe do ataque, nunca num arquivo de série.
//
// Regras de honestidade do cálculo:
//   - janela maior que o que existe no ring é marcada com "parcial": o painel
//     diz "parcial", não finge 24 h de dado quando só tem 20 min;
//   - dia sem evento aparece com barra zero, não com estimativa;
//   - /healthz do docker (canário) não entra em nenhuma contagem de visitante.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	janelaCincoMin = 5 * time.Minute
	janelaHora     = time.Hour
	janelaDia      = 24 * time.Hour
	limiteEventos  = 60000 // ~1 dia de tráfego atual, com folga
	topN           = 8
	limiteFeed     = 25
	minutosSerie   = 60
	diasSerie      = 7
	limiteFloodMin = 120 // req do mesmo IP em 60 s = flood (mesmo limiar do vigia)
)

type coletor struct {
	mu sync.RWMutex

	eventos []evento
	limite  int
	inicio  time.Time

	lidos   uint64
	canario uint64

	serieDia     map[string][3]int // "2006-01-02" -> {humano, bot, ataque}
	arquivoSerie string
	ultimoSalvo  time.Time

	// espelho do estado do vigia (var/defesa/estado.json)
	vigiaAtivo      int
	vigiaTotal      int
	vigiaUltimaExec string
	vigiaIPs        []string
}

func novoColetor(arquivoSerie string) *coletor {
	c := &coletor{
		eventos:      make([]evento, 0, 4096),
		limite:       limiteEventos,
		inicio:       time.Now(),
		serieDia:     map[string][3]int{},
		arquivoSerie: arquivoSerie,
	}
	c.carregarSerie()
	return c
}

func (c *coletor) registrar(ev evento) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.lidos++
	if ev.Canario {
		c.canario++
		return
	}
	c.eventos = append(c.eventos, ev)

	dia := ev.Quando.In(time.Local).Format("2006-01-02")
	atual := c.serieDia[dia]
	switch {
	case ev.Ataque != "":
		atual[2]++
	case ev.Bot:
		atual[1]++
	default:
		atual[0]++
	}
	c.serieDia[dia] = atual
}

// limpar tira o que passou de 24 h de memória e corta o ring no limite.
func (c *coletor) limpar() {
	c.mu.Lock()
	defer c.mu.Unlock()

	corte := time.Now().Add(-janelaDia - 5*time.Minute)
	inicio := 0
	for inicio < len(c.eventos) && c.eventos[inicio].Quando.Before(corte) {
		inicio++
	}
	if inicio > 0 {
		c.eventos = append([]evento(nil), c.eventos[inicio:]...)
	}
	if len(c.eventos) > c.limite {
		c.eventos = append([]evento(nil), c.eventos[len(c.eventos)-c.limite:]...)
	}

	if time.Since(c.ultimoSalvo) > 30*time.Second {
		c.ultimoSalvo = time.Now()
		c.salvarSerie()
	}
}

func (c *coletor) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.eventos = c.eventos[:0]
}

// ---------------------------------------------------------------- persistência

func (c *coletor) carregarSerie() {
	dados, err := os.ReadFile(c.arquivoSerie)
	if err != nil {
		return
	}
	var lido map[string][3]int
	if json.Unmarshal(dados, &lido) != nil {
		return
	}
	for chave, valor := range lido {
		c.serieDia[chave] = valor
	}
}

// salvarSerie grava o MAIOR valor já visto por dia (nunca o menor): o log é
// truncado em 5 MB, então a memória pode perder evento — mas o número não
// diminui para trás, que é o que daria a impressão de tráfego "desaparecido".
func (c *coletor) salvarSerie() {
	copia := make(map[string][3]int, len(c.serieDia))
	for chave, valor := range c.serieDia {
		copia[chave] = valor
	}
	temporario := c.arquivoSerie + ".tmp"
	dados, err := json.MarshalIndent(copia, "", " ")
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(c.arquivoSerie), 0o700) != nil {
		return
	}
	if os.WriteFile(temporario, dados, 0o600) != nil {
		return
	}
	_ = os.Rename(temporario, c.arquivoSerie)
}

// ---------------------------------------------------------------- snapshot

type itemTop struct {
	Chave  string `json:"chave"`
	N      int    `json:"n"`
	Rotulo string `json:"rotulo,omitempty"`
}

type pontoSerie struct {
	Rotulo string `json:"rotulo"`
	Chave  string `json:"chave"`
	Humano int    `json:"humano"`
	Bot    int    `json:"bot"`
	Ataque int    `json:"ataque"`
}

type linhaHost struct {
	Host   string `json:"host"`
	Humano int    `json:"humano"`
	Bot    int    `json:"bot"`
	Ataque int    `json:"ataque"`
	Total  int    `json:"total"`
}

type registroAtaque struct {
	Tipo      string `json:"tipo"`
	IP        string `json:"ip"`
	Host      string `json:"host"`
	Caminho   string `json:"caminho"`
	N         int    `json:"n"`
	Primeiro  string `json:"primeiro"`
	Ultimo    string `json:"ultimo"`
	Bloqueado bool   `json:"bloqueado"`
}

type insight struct {
	Nivel string `json:"nivel"` // alerta | atencao | ok | info
	Texto string `json:"texto"`
}

type janela struct {
	Nome       string           `json:"nome"`
	Segundos   int              `json:"segundos"`
	Total      int              `json:"total"`
	ReqS       float64          `json:"req_s"`
	Humano     int              `json:"humano"`
	Bot        int              `json:"bot"`
	Ataques    int              `json:"ataques"`
	PorClasse  map[string]int   `json:"por_classe"`
	ClasseReq  map[string]int   `json:"classe_chamadas"`
	Unicos     map[string]int   `json:"unicos"`
	BotsAtivos int              `json:"bots_ativos"`
	Bloqueados int              `json:"bloqueados"`
	TopIPs     []itemTop        `json:"top_ips"`
	TopHosts   []itemTop        `json:"top_hosts"`
	TopCamin   []itemTop        `json:"top_caminhos"`
	TopUAs     []itemTop        `json:"top_uas"`
	Hosts      []linhaHost      `json:"hosts"`
	AtaqueTipo map[string]int   `json:"ataque_tipo"`
	AtaquesReg []registroAtaque `json:"ataques_reg"`
}

type feedItem struct {
	Hora    string `json:"hora"`
	IP      string `json:"ip"`
	Host    string `json:"host"`
	Metodo  string `json:"metodo"`
	Caminho string `json:"caminho"`
	Status  int    `json:"status"`
	Ataque  string `json:"ataque"`
	Bot     bool   `json:"bot"`
}

type snapshot struct {
	GeradoEm   string            `json:"gerado_em"`
	UptimeS    int               `json:"uptime_s"`
	Lidos      uint64            `json:"lidos"`
	Canario    uint64            `json:"canario"`
	Janelas    map[string]janela `json:"janelas"`
	SerieMin   []pontoSerie      `json:"serie_min"`
	SerieDia   []pontoSerie      `json:"serie_dia"`
	Insights   []insight         `json:"insights"`
	Feed       []feedItem        `json:"feed"`
	Vigia      map[string]any    `json:"vigia"`
	Suspeitos  []suspeito        `json:"suspeitos"`
	Suspeita   map[string]int    `json:"suspeita_resumo"`
	Infra      infraLocal        `json:"infra_local"`
	Borda      infraLocal        `json:"borda"`
	Parcial24h bool              `json:"parcial_24h"`
}

// foto monta o retrato agora. Uma passada pela fatia para cada janela.
func (c *coletor) foto() snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()

	agora := time.Now()
	snap := snapshot{
		GeradoEm: agora.In(time.Local).Format(time.RFC3339),
		UptimeS:  int(agora.Sub(c.inicio).Seconds()),
		Lidos:    c.lidos,
		Canario:  c.canario,
		Janelas:  map[string]janela{},
	}
	snap.Vigia = map[string]any{
		"bloqueios_ativos": c.vigiaAtivo,
		"total_bloqueios":  c.vigiaTotal,
		"ultima_execucao":  c.vigiaUltimaExec,
		"ips":              c.vigiaIPs,
	}

	maisAntigo := agora
	if len(c.eventos) > 0 {
		maisAntigo = c.eventos[0].Quando
	}
	snap.Parcial24h = agora.Sub(maisAntigo) < janelaDia-2*time.Minute

	for _, def := range []struct {
		nome    string
		duracao time.Duration
	}{
		{"5m", janelaCincoMin},
		{"1h", janelaHora},
		{"24h", janelaDia},
	} {
		snap.Janelas[def.nome] = c.calcularJanela(def.nome, def.duracao, agora)
	}

	snap.SerieMin = c.serieMinutos(agora, time.Minute)
	snap.SerieDia = c.serieDias(agora)
	// Escore de suspeita: uma passada, todos os IPs, e a lista exibida começa
	// em "observar" (limpo não interessa a ninguém). Infra local (loopback,
	// RFC1918, gateway do docker) fica FORA do escore e é retratada à parte.
	todos := calcularSuspeitos(c.eventos, agora, 0)
	snap.Infra = resumoInfraLocal(c.eventos)
	snap.Borda = resumoBorda(c.eventos)
	snap.Suspeita = map[string]int{NivelLimpo: 0, NivelObservar: 0, NivelSuspeito: 0, NivelMalicioso: 0}
	for i := range todos {
		snap.Suspeita[todos[i].Nivel]++
	}
	snap.Suspeitos = make([]suspeito, 0, 8)
	for i := range todos {
		if todos[i].Escore >= escoreObservar {
			snap.Suspeitos = append(snap.Suspeitos, todos[i])
		}
		if len(snap.Suspeitos) >= 20 {
			break
		}
	}
	refs := referencias{}
	refs.taxaAnterior, refs.temTaxa = c.taxaAnterior(25 * time.Minute)
	refs.ultimoAtaque, refs.temAtaque = c.ultimoAtaque()
	snap.Insights = gerarInsights(&snap, refs)
	snap.Feed = c.feed(agora)
	return snap
}

func (c *coletor) calcularJanela(nome string, duracao time.Duration, agora time.Time) janela {
	corte := agora.Add(-duracao)
	corteMinuto := agora.Add(-time.Minute)

	j := janela{
		Nome:       nome,
		Segundos:   int(duracao.Seconds()),
		PorClasse:  map[string]int{"2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0},
		ClasseReq:  map[string]int{},
		Unicos:     map[string]int{},
		TopIPs:     []itemTop{},
		TopHosts:   []itemTop{},
		TopCamin:   []itemTop{},
		TopUAs:     []itemTop{},
		Hosts:      []linhaHost{},
		AtaqueTipo: map[string]int{},
		AtaquesReg: []registroAtaque{},
	}

	ips := map[string]int{}
	hosts := map[string]int{}
	caminhos := map[string]int{}
	uas := map[string]int{}
	botsIP := map[string]struct{}{}
	bloqIP := map[string]struct{}{}
	porHost := map[string]*linhaHost{}
	porIPMinuto := map[string]int{}
	ataques := map[string]*registroAtaque{}

	for i := range c.eventos {
		ev := &c.eventos[i]
		if ev.Quando.Before(corte) {
			continue
		}
		quando := ev.Quando.In(time.Local)

		j.Total++
		switch {
		case ev.Status >= 500:
			j.PorClasse["5xx"]++
		case ev.Status >= 400:
			j.PorClasse["4xx"]++
		case ev.Status >= 300:
			j.PorClasse["3xx"]++
		case ev.Status >= 200:
			j.PorClasse["2xx"]++
		}
		j.ClasseReq[ev.Metodo]++

		ips[ev.IP]++
		hosts[ev.Host]++
		caminhos[normalizarCaminho(ev.Caminho)]++
		uas[resumoUA(ev.UA)]++
		if ev.Bloqueado || ev.Status == 403 {
			bloqIP[ev.IP] = struct{}{}
		}

		linha := porHost[ev.Host]
		if linha == nil {
			linha = &linhaHost{Host: ev.Host}
			porHost[ev.Host] = linha
		}
		linha.Total++

		switch {
		case ev.Ataque != "":
			j.Ataques++
			linha.Ataque++
			j.AtaqueTipo[ev.Ataque]++
		case ev.Bot:
			j.Bot++
			linha.Bot++
			if seg := agora.Sub(ev.Quando); seg <= janelaCincoMin {
				botsIP[ev.IP] = struct{}{}
			}
		default:
			j.Humano++
			linha.Humano++
		}

		if !quando.Before(corteMinuto) {
			porIPMinuto[ev.IP]++
		}

		if ev.Ataque != "" {
			chave := ev.Ataque + "|" + ev.IP + "|" + ev.Host
			reg := ataques[chave]
			if reg == nil {
				reg = &registroAtaque{
					Tipo:     ev.Ataque,
					IP:       ev.IP,
					Host:     ev.Host,
					Primeiro: quando.Format("15:04:05"),
				}
				ataques[chave] = reg
			}
			reg.N++
			reg.Ultimo = quando.Format("15:04:05")
			reg.Caminho = truncar(ev.Alvo, 70)
			if ev.Bloqueado || ev.Status == 403 {
				reg.Bloqueado = true
			}
		}
	}

	// Flood por taxa: IP que passou de 120 req no último minuto entra como
	// ataque mesmo sem 429 (o nginx só começa a cortar na rajada).
	for ip, n := range porIPMinuto {
		if n < limiteFloodMin {
			continue
		}
		chave := AtaqueFlood + "|" + ip + "|" + "?"
		ataques[chave] = &registroAtaque{
			Tipo: AtaqueFlood, IP: ip, Host: "?", N: n,
			Caminho:   "≥" + itoa(n) + " req/60 s",
			Primeiro:  agora.Add(-time.Minute).Format("15:04:05"),
			Ultimo:    agora.Format("15:04:05"),
			Bloqueado: false,
		}
		j.AtaqueTipo[AtaqueFlood]++
	}

	j.ReqS = float64(j.Total) / duracao.Seconds()
	j.Unicos = c.unicosAgora()
	j.BotsAtivos = len(botsIP)
	j.Bloqueados = len(bloqIP)
	j.TopIPs = topo(ips, "", topN)
	j.TopHosts = topo(hosts, "", topN)
	j.TopCamin = topo(caminhos, "", topN)
	j.TopUAs = topo(uas, "", topN)

	for _, linha := range porHost {
		j.Hosts = append(j.Hosts, *linha)
	}
	sort.Slice(j.Hosts, func(a, b int) bool { return j.Hosts[a].Total > j.Hosts[b].Total })

	for _, reg := range ataques {
		j.AtaquesReg = append(j.AtaquesReg, *reg)
	}
	sort.Slice(j.AtaquesReg, func(a, b int) bool {
		if j.AtaquesReg[a].N != j.AtaquesReg[b].N {
			return j.AtaquesReg[a].N > j.AtaquesReg[b].N
		}
		return j.AtaquesReg[a].Ultimo > j.AtaquesReg[b].Ultimo
	})
	if len(j.AtaquesReg) > 40 {
		j.AtaquesReg = j.AtaquesReg[:40]
	}
	return j
}

// unicosAgora conta visitantes humanos distintos no último minuto e na última
// hora — independente da janela escolhida no painel. Sem isto, a janela de
// 5 min responderia "visitantes 1 h" com 5 min de dado (número errado com
// rótulo certo), que é pior que não mostrar.
// NÃO trava: chamada de dentro de foto(), com c.mu.RLock preso.
func (c *coletor) unicosAgora() map[string]int {
	agora := time.Now()
	minuto := map[string]struct{}{}
	hora := map[string]struct{}{}

	for i := len(c.eventos) - 1; i >= 0; i-- {
		ev := &c.eventos[i]
		if agora.Sub(ev.Quando) > janelaHora {
			break // os eventos estão em ordem cronológica
		}
		if ev.Bot || ev.Ataque != "" {
			continue
		}
		hora[ev.IP] = struct{}{}
		if agora.Sub(ev.Quando) <= time.Minute {
			minuto[ev.IP] = struct{}{}
		}
	}
	return map[string]int{"minuto": len(minuto), "hora": len(hora)}
}

func topo(contagem map[string]int, rotulo string, n int) []itemTop {
	itens := make([]itemTop, 0, len(contagem))
	for chave, valor := range contagem {
		itens = append(itens, itemTop{Chave: chave, N: valor, Rotulo: rotulo})
	}
	sort.Slice(itens, func(a, b int) bool {
		if itens[a].N != itens[b].N {
			return itens[a].N > itens[b].N
		}
		return itens[a].Chave < itens[b].Chave
	})
	if len(itens) > n {
		itens = itens[:n]
	}
	return itens
}

// serieMinutos monta os últimos 60 minutos, com passo opcional (o gráfico
// longo usa passo 5 para caber). Minuto sem evento sai com zero.
// NÃO trava: quem chama (foto) já está com c.mu.RLock preso.
func (c *coletor) serieMinutos(agora time.Time, passo time.Duration) []pontoSerie {
	minutoAtual := agora.Truncate(time.Minute)
	quantos := int(minutosSerie * time.Minute / passo)
	saida := make([]pontoSerie, quantos)

	indice := map[string]int{}
	for i := 0; i < quantos; i++ {
		inicio := minutoAtual.Add(-time.Duration(quantos-1-i) * passo)
		chave := inicio.Format("2006-01-02T15:04")
		saida[i] = pontoSerie{Chave: chave, Rotulo: inicio.Format("15:04")}
		indice[chave] = i
	}

	for i := range c.eventos {
		ev := &c.eventos[i]
		quando := ev.Quando.In(time.Local)
		chave := quando.Truncate(passo).Format("2006-01-02T15:04")
		pos, existe := indice[chave]
		if !existe {
			continue
		}
		switch {
		case ev.Ataque != "":
			saida[pos].Ataque++
		case ev.Bot:
			saida[pos].Bot++
		default:
			saida[pos].Humano++
		}
	}
	return saida
}

func (c *coletor) serieDias(agora time.Time) []pontoSerie {
	saida := make([]pontoSerie, 0, diasSerie)
	for i := 0; i < diasSerie; i++ {
		dia := agora.AddDate(0, 0, -(diasSerie - 1 - i))
		chave := dia.Format("2006-01-02")
		valor := c.serieDia[chave]
		saida = append(saida, pontoSerie{
			Chave:  chave,
			Rotulo: chave[8:10] + "/" + chave[5:7],
			Humano: valor[0],
			Bot:    valor[1],
			Ataque: valor[2],
		})
	}
	return saida
}

func (c *coletor) feed(agora time.Time) []feedItem {
	itens := make([]feedItem, 0, limiteFeed)
	for i := len(c.eventos) - 1; i >= 0 && len(itens) < limiteFeed; i-- {
		ev := &c.eventos[i]
		itens = append(itens, feedItem{
			Hora:    ev.Quando.In(time.Local).Format("15:04:05"),
			IP:      ev.IP,
			Host:    ev.Host,
			Metodo:  ev.Metodo,
			Caminho: truncar(ev.Alvo, 70),
			Status:  ev.Status,
			Ataque:  ev.Ataque,
			Bot:     ev.Bot,
		})
	}
	return itens
}

func truncar(texto string, limite int) string {
	if len(texto) <= limite {
		return texto
	}
	return texto[:limite] + "…"
}

func itoa(valor int) string {
	if valor == 0 {
		return "0"
	}
	negativo := valor < 0
	if negativo {
		valor = -valor
	}
	digitos := make([]byte, 0, 12)
	for valor > 0 {
		digitos = append([]byte{byte('0' + valor%10)}, digitos...)
		valor /= 10
	}
	if negativo {
		return "-" + string(digitos)
	}
	return string(digitos)
}
