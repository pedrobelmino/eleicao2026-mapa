// Caixa flutuante (tooltip) do mapa — decisão de UMA linha só.
//
// O tooltip nasceu para o mouse: no desktop ele aparece no hover e no clique.
// No celular ele vira uma caixa fixa por cima do mapa, que é exatamente o que o
// botão "Mostrar detalhes" resolve melhor (decisão do Pedro, 24/10/2026).
//
// A decisão vive aqui e TODOS os handlers do mapa (UF, município, zona, local)
// perguntam antes de desenhar: um lugar para mudar e nenhum `if` espalhado.
//
// Regra: ponteiro grosso (toque) OU tela estreita (<= 820px, a mesma faixa do
// layout mobile) não mostram caixa nenhuma. Fora isso, comportamento de sempre.
export function podeMostrarTooltip(win = typeof window === 'undefined' ? null : window) {
  if (!win || typeof win.matchMedia !== 'function') return true
  if (win.matchMedia('(pointer: coarse)').matches) return false
  if (win.matchMedia('(max-width: 820px)').matches) return false
  return true
}
