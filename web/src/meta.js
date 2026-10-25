// Título e descrição por rota. O index.html traz os do PAINEL, porque a raiz
// redireciona para /eleicao (e é o que bots de link leem antes do JS rodar); a
// landing em /sobre e o mapa trocam os dois ao montar, para o histórico/aba do
// navegador dizer a verdade em cada nível.
export const META_PAINEL = {
  titulo: 'Eleição 2026 — Presidente · apuração em tempo real',
  descricao:
    'Apuração da eleição presidencial de 2026 em tempo real, direto dos dados oficiais do TSE: placar nacional, por região, por estado e linha do tempo.',
}

export const META_LANDING = {
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
