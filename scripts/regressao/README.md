# Regressão do eleicao2026.belmino.dev

Rodar: `bash scripts/regressao/regressao.sh --rapido` (5 itens, ~3 min) ou `--completo` (8 itens, ~10 min);
`--base http://127.0.0.1:8100` mede o stack de teste (padrão 8110, o de produção, só leitura).

Cada item roda a prova que já existe em `scripts/provas/` e classifica pelo artefato gravado, nunca por
"deve funcionar": **PASS** = critério do `CHECKLIST.json` bateu no artefato; **FAIL** = rodou e o critério
não bateu (a regressão está acusando); **NAO_MEDIDO** = não deu para medir (timeout, script ausente,
artefato sem o campo final, site fora do ar) — NAO_MEDIDO nunca vira PASS.

Saída em `_provas/regressao/<AAAAMMDD-HHMM>/`: `resultado.json` (id, status, medida, duração, critério,
origem), `resumo.txt` e um log por item. Exit: 0 sem FAIL e sem NAO_MEDIDO · 1 com FAIL · 2 com NAO_MEDIDO.

Regra dura: **item que falha vira correção antes de feature nova** — não se abre item novo do ROADMAP com
a regressão vermelha. Item novo entra no `CHECKLIST.json` com prova já escrita em `scripts/provas/`;
sem prova, não entra.
