// Título e descrição por rota. O index.html traz os da landing (a raiz é a
// porta de entrada); o painel da eleição e o mapa trocam os dois ao montar,
// para o histórico/aba do navegador dizer a verdade em cada nível.
export const META_RAIZ = {
  titulo: 'Pedro Belmino — Analista de Sistemas',
  descricao:
    'Pedro Belmino, analista de sistemas. Desenvolvimento em Java, Go e IA. Perfis no LinkedIn, GitHub, Medium e no canal Belmino Souls. Monitoramento da eleição 2026 em tempo real.',
}

export function definirMeta({ titulo, descricao }) {
  if (typeof document === 'undefined') return
  if (titulo) document.title = titulo
  if (!descricao) return
  let etiqueta = document.querySelector('meta[name="description"]')
  if (!etiqueta) {
    etiqueta = document.createElement('meta')
    etiqueta.setAttribute('name', 'description')
    document.head.appendChild(etiqueta)
  }
  etiqueta.setAttribute('content', descricao)
}
