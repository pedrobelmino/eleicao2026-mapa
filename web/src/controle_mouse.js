/**
 * Controle de mouse para MapLibre GL JS 5.x.
 *
 * Regras principais:
 * - botao direito + arraste vertical = zoom (sem alterar bearing nem pitch);
 * - menu de contexto suprimido no canvas e no container;
 * - rotacao sempre travada em 0.
 *
 * O modulo usa apenas eventos nativos do DOM e a API publica da instancia do
 * mapa, sem depender de nenhuma variavel global da biblioteca.
 */

const FATOR_ZOOM = 0.01;

function obterJanela() {
  // Em navegador, window e o alvo esperado. O fallback permite testar o modulo
  // em ambientes que expõem apenas globalThis.
  return typeof window !== "undefined" ? window : globalThis;
}

export function instalarControleDeMouse(mapa, opcoes = {}) {
  // `opcoes` fica reservado para evolucoes futuras da API sem quebrar a
  // assinatura exigida.
  void opcoes;

  const canvas = mapa.getCanvas();
  const container =
    typeof mapa.getContainer === "function" ? mapa.getContainer() : null;
  const janela = obterJanela();

  // Contadores globais usados para diagnostico/teste. Nao zeramos valores ja
  // existentes para nao apagar a contagem de outra instalacao na mesma pagina.
  if (!Number.isFinite(janela.__contextmenuEventos)) {
    janela.__contextmenuEventos = 0;
  }
  if (typeof janela.__contextmenuAberto !== "boolean") {
    janela.__contextmenuAberto = false;
  }

  // Um mesmo evento de contextmenu borbulha do canvas para o container. O
  // WeakSet garante que ele seja contado uma unica vez, mesmo com os dois
  // listeners ativos.
  const eventosDeContextoContados = new WeakSet();

  function aoContextMenu(evento) {
    if (!eventosDeContextoContados.has(evento)) {
      eventosDeContextoContados.add(evento);
      janela.__contextmenuEventos += 1;
    }

    // Ctrl/meta devem preservar o menu nativo. Nesse caso nao chamamos
    // preventDefault e registramos que o menu pode ter sido aberto.
    if (evento.ctrlKey || evento.metaKey) {
      if (!evento.defaultPrevented) {
        janela.__contextmenuAberto = true;
      }
      return;
    }

    // O botao direito e usado para zoom; por isso o menu do navegador precisa
    // ser cancelado tanto no canvas quanto no container (o evento borbulha).
    evento.preventDefault();

    // Se o evento nao for cancelavel (ou outro codigo ja o tiver cancelado),
    // ele nao chegou a abrir o menu. So marcamos aberto quando de fato nao
    // houve prevencao.
    if (!evento.defaultPrevented) {
      janela.__contextmenuAberto = true;
    }
  }

  // Estado do arraste com o botao direito.
  let arrastando = false;
  let ponteiroAtivo = null;
  let zoomInicial = 0;
  let yInicial = 0;

  function limitesDeZoom() {
    // Lemos os limites a cada movimento para respeitar mudancas de configuracao
    // feitas no mapa depois da instalacao.
    const minimo =
      typeof mapa.getMinZoom === "function" ? mapa.getMinZoom() : -Infinity;
    const maximo =
      typeof mapa.getMaxZoom === "function" ? mapa.getMaxZoom() : Infinity;

    return {
      minimo: Number.isFinite(minimo) ? minimo : -Infinity,
      maximo: Number.isFinite(maximo) ? maximo : Infinity,
    };
  }

  function encerrarArraste(idPonteiro) {
    arrastando = false;
    ponteiroAtivo = null;

    // A captura pode ja ter sido liberada pelo navegador; por isso a liberacao
    // e defensiva.
    if (
      idPonteiro !== null &&
      typeof canvas.releasePointerCapture === "function"
    ) {
      try {
        canvas.releasePointerCapture(idPonteiro);
      } catch {
        // Ignora apenas a liberacao de um ponteiro que ja nao esta capturado.
      }
    }
  }

  function aoPointerDown(evento) {
    // Apenas o botao direito inicia o gesto. Ctrl/meta sao ignorados para
    // deixar o menu nativo funcionar nesses casos.
    if (evento.button !== 2 || evento.ctrlKey || evento.metaKey) {
      return;
    }
    if (arrastando) {
      return;
    }

    arrastando = true;
    ponteiroAtivo = evento.pointerId;
    zoomInicial = mapa.getZoom();
    yInicial = evento.clientY;

    // A captura mantem pointermove/pointerup chegando ao canvas mesmo quando o
    // cursor sai da area do mapa durante o arraste.
    if (typeof canvas.setPointerCapture === "function") {
      try {
        canvas.setPointerCapture(evento.pointerId);
      } catch {
        // Em eventos sinteticos o ponteiro pode nao existir; o gesto continua
        // funcionando enquanto o cursor permanecer sobre o canvas.
      }
    }
  }

  function aoPointerMove(evento) {
    if (!arrastando || evento.pointerId !== ponteiroAtivo) {
      return;
    }

    // Em pointermove o campo `button` normalmente vale -1; o gesto ja foi
    // qualificado como botao direito no pointerdown. Usamos somente o eixo Y:
    // o deslocamento horizontal nao pode alterar bearing nem pitch.
    const { minimo, maximo } = limitesDeZoom();
    const zoomCalculado =
      zoomInicial + (yInicial - evento.clientY) * FATOR_ZOOM;
    const zoomLimitado = Math.min(maximo, Math.max(minimo, zoomCalculado));

    // Passamos apenas `zoom`: nao enviamos bearing nem pitch, pois o arraste
    // vertical deve mexer exclusivamente na escala.
    mapa.jumpTo({ zoom: zoomLimitado });
  }

  function aoPointerUp(evento) {
    if (!arrastando || evento.pointerId !== ponteiroAtivo) {
      return;
    }
    if (evento.button !== 2) {
      return;
    }

    encerrarArraste(evento.pointerId);
  }

  // O MapLibre usa o botao direito para rotacionar por padrao. Desligamos os
  // controles de rotacao/pitch para que esse gesto pertenca ao zoom vertical.
  const controlesParaRestaurar = [];

  function desativarControle(controle, metodoDesativar, metodoRestaurar) {
    if (!controle || typeof controle[metodoDesativar] !== "function") {
      return;
    }

    let estavaAtivo = true;
    if (typeof controle.isEnabled === "function") {
      try {
        estavaAtivo = Boolean(controle.isEnabled());
      } catch {
        estavaAtivo = true;
      }
    }

    controle[metodoDesativar]();

    // Guardamos a acao inversa apenas se o controle estava ativo, para que
    // `desinstalar` devolva o mapa ao estado anterior.
    if (estavaAtivo && typeof controle[metodoRestaurar] === "function") {
      controlesParaRestaurar.push([controle, metodoRestaurar]);
    }
  }

  desativarControle(mapa.dragRotate, "disable", "enable");
  desativarControle(mapa.touchZoomRotate, "disableRotation", "enableRotation");
  desativarControle(mapa.keyboard, "disableRotation", "enableRotation");
  desativarControle(mapa.touchPitch, "disable", "enable");

  function aoRotacionar() {
    // A trava e aplicada no evento `rotate`: qualquer tentativa de rotacao
    // (inclusive programatica) volta imediatamente para bearing 0.
    if (typeof mapa.getBearing !== "function") {
      return;
    }
    if (mapa.getBearing() !== 0) {
      mapa.jumpTo({ bearing: 0 });
    }
  }

  mapa.on("rotate", aoRotacionar);

  // Se o mapa ja tiver sido criado com bearing diferente de zero, a trava
  // tambem vale desde o primeiro instante.
  if (typeof mapa.getBearing === "function" && mapa.getBearing() !== 0) {
    mapa.jumpTo({ bearing: 0 });
  }

  // O canvas recebe o gesto; o menu de contexto e suprimido nos dois niveis
  // porque o evento pode ser disparado diretamente no container.
  canvas.addEventListener("contextmenu", aoContextMenu);
  if (container && container !== canvas) {
    container.addEventListener("contextmenu", aoContextMenu);
  }

  canvas.addEventListener("pointerdown", aoPointerDown);
  canvas.addEventListener("pointermove", aoPointerMove);
  canvas.addEventListener("pointerup", aoPointerUp);

  function desinstalar() {
    canvas.removeEventListener("contextmenu", aoContextMenu);
    if (container && container !== canvas) {
      container.removeEventListener("contextmenu", aoContextMenu);
    }

    canvas.removeEventListener("pointerdown", aoPointerDown);
    canvas.removeEventListener("pointermove", aoPointerMove);
    canvas.removeEventListener("pointerup", aoPointerUp);

    if (arrastando) {
      encerrarArraste(ponteiroAtivo);
    }

    if (typeof mapa.off === "function") {
      mapa.off("rotate", aoRotacionar);
    }

    // Restaura somente os controles que estavam ativos antes da instalacao.
    for (let i = controlesParaRestaurar.length - 1; i >= 0; i -= 1) {
      const [controle, metodoRestaurar] = controlesParaRestaurar[i];
      try {
        controle[metodoRestaurar]();
      } catch {
        // Uma falha ao restaurar um controle nao deve impedir a desinstalacao.
      }
    }
    controlesParaRestaurar.length = 0;
  }

  return {
    desinstalar,
    descricao:
      "Zoom com o botão direito, menu de contexto suprimido e rotação travada em 0",
  };
}
