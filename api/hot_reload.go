package main

// Recarga do retrato público SEM reiniciar o processo.
//
// O sintoma que isto resolve (25/10/2026): a cada coleta o script publicava
// dados/publico.json e reiniciava a api para o dado novo entrar em memória.
// Durante o recreate (medido: ~9 s) o nginx respondia 502 para quem estava com
// a página aberta — 12 janelas de erro por hora, em plena apuração.
//
// Desenho:
//   * uma goroutine faz `stat` do publico.json a cada 2 s (só metadados, sem
//     abrir o arquivo); quando mtime/tamanho mudam, recarrega;
//   * o estado servido é trocado por ATÔMICO (atomic.Pointer[dados]). Cada
//     requisição pega o ponteiro UMA vez (a.dados()) e trabalha com ele até o
//     fim: ninguém vê struct meio montada e ninguém pega panic de troca;
//   * releitura inválida (JSON truncado, arquivo ilegível, malha inconsistente)
//     NÃO troca nada: o retrato anterior continua no ar e o log registra o
//     aviso. Payload vazio por causa de releitura é o defeito que isto evita.
//
// O publicador (coleta_apuracao.sh) escreve em tmp + rename no mesmo diretório,
// então o `stat` ou vê o arquivo antigo inteiro ou o novo inteiro. Ainda assim a
// checagem de validade existe porque disco cheio e coletor morto no meio existem.

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"
)

// intervaloEstatoDados é o custo de cada tique: um stat (sem abrir o arquivo).
// 2 s é o menor intervalo que ainda dá margem para uma coleta de 10 min sem
// gastar syscall à toa.
const intervaloEstatoDados = 2 * time.Second

// pausaAposFalha evita martelar o mesmo arquivo inválido a cada 2 s: depois de
// uma falha de carga, a próxima tentativa só acontece se o arquivo mudar OU se
// passarem 15 s (o publicador pode ter publicado de novo com mesmo tamanho).
const pausaAposFalha = 15 * time.Second

// assinaturaArquivo identifica a versão em disco sem abrir o conteúdo. mtime em
// nanossegundos porque o publicador faz rename: o mtime do arquivo novo é o da
// escrita, quase sempre dentro do mesmo segundo do anterior.
type assinaturaArquivo struct {
	existe  bool
	tamanho int64
	mtime   int64
}

func assinarArquivo(caminho string) assinaturaArquivo {
	info, err := os.Stat(caminho)
	if err != nil {
		return assinaturaArquivo{}
	}
	return assinaturaArquivo{existe: true, tamanho: info.Size(), mtime: info.ModTime().UnixNano()}
}

// dados devolve o retrato público atualmente no ar. Toda requisição deve
// chamar isto UMA vez e usar o ponteiro devolvido até o fim da resposta.
func (a *app) dados() *dados {
	return a.dadosPtr.Load()
}

// iniciarVigiaDados sobe a goroutine de recarga. Chamada uma vez, no boot.
func (a *app) iniciarVigiaDados() {
	caminhoPublico := filepath.Join(a.cfg.DadosDir, "publico.json")
	vigiado := assinarArquivo(caminhoPublico)
	if !vigiado.existe {
		log.Printf("hot-reload: aviso: %s não existe no boot; vigia começa quando aparecer", caminhoPublico)
	}
	log.Printf("hot-reload: vigiando %s a cada %s", caminhoPublico, intervaloEstatoDados)

	go func() {
		tique := time.NewTicker(intervaloEstatoDados)
		defer tique.Stop()
		for range tique.C {
			a.recarregarSeMudou(caminhoPublico, &vigiado)
		}
	}()
}

// recarregarSeMudou é um tique do vigia. Separada da goroutine para poder ser
// exercitada direto nos testes, sem relógio.
func (a *app) recarregarSeMudou(caminhoPublico string, vigiado *assinaturaArquivo) {
	atual := assinarArquivo(caminhoPublico)
	if atual == *vigiado {
		return
	}

	// Arquivo sumiu no meio (instante entre rm e rename de um publicador que
	// não usa tmp+rename): não mexe no que está no ar e tenta de novo no
	// próximo tique, porque a assinatura continua a do arquivo carregado.
	if !atual.existe {
		log.Printf("hot-reload: %s desapareceu; mantido o retrato atual (tento de novo em %s)", caminhoPublico, intervaloEstatoDados)
		return
	}

	inicio := time.Now()
	novo, err := carregarDados(a.cfg.DadosDir, a.cfg.ApuracaoDemo)
	if err == nil {
		err = validarRetrato(novo)
	}

	if err != nil {
		// Nada é trocado. O retrato antigo continua servindo a página de quem
		// está apurando; o log guarda o motivo para o painel/monitor ver.
		antigo := a.dados()
		geradoAntigo := "?"
		if antigo != nil && antigo.Publico != nil {
			geradoAntigo = antigo.Publico.GeradoEm
		}
		log.Printf("hot-reload: AVISO %s mudou mas não carregou (%v); mantido o retrato gerado_em=%s",
			caminhoPublico, err, geradoAntigo)
		// Marca a assinatura como vista para não repetir o mesmo aviso a cada
		// 2 s; a próxima publicação muda o mtime e volta a tentar.
		*vigiado = atual
		return
	}

	antigo := a.dadosPtr.Swap(novo)
	*vigiado = atual

	geradoAntigo := "?"
	if antigo != nil && antigo.Publico != nil {
		geradoAntigo = antigo.Publico.GeradoEm
	}
	log.Printf("hot-reload: recarregado em %dms (gerado_em %s -> %s; %d UFs, %d features)",
		time.Since(inicio).Milliseconds(), geradoAntigo, novo.Publico.GeradoEm,
		len(novo.Publico.UFs), len(novo.Malha.Features))
}

// validarRetrato é o portão contra "servir vazio": um arquivo que decodifica
// mas não tem UF nem malha derrubaria o mapa com payload zerado. Nesse caso é
// melhor continuar com o retrato anterior do que publicar tela em branco.
func validarRetrato(d *dados) error {
	if d == nil || d.Publico == nil {
		return fmt.Errorf("retrato vazio (publico ausente)")
	}
	if len(d.Publico.UFs) == 0 {
		return fmt.Errorf("retrato sem UF (publico.json sem .ufs)")
	}
	if len(d.Malha.Features) == 0 {
		return fmt.Errorf("malha sem feature (malha_uf.geojson vazio)")
	}
	if len(d.PublicoBruto) == 0 {
		return fmt.Errorf("bytes do publico.json vazios")
	}
	return nil
}
