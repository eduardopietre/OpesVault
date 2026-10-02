# Implementação das fases 1 a 10

Versão 1.1 • 02/10/2026. Registra o que foi construído em cada fase do roadmap (`09` §1), como os critérios de saída foram verificados e o que continua pendente. A fase 0 está em `11`. Das fases 7 a 10 foi feito o que não depende do Windows nem de documentos reais (§2.1); o andamento detalhado está no `09` §1.4.

**Escopo da verificação:** tudo foi testado em Python no Linux, com testes automatizados e interface em modo `offscreen`. Os gates do Windows continuam presumidos aprovados (`11` §4). Os layouts de faturas e extratos são sintéticos até haver documentos reais.

## 1. Mapa do código

| Pacote | Conteúdo |
|---|---|
| `domain/` | Dinheiro exato (`money`), entidades (`model`), agregado `Ledger` com invariantes, histórico e registro de alterações para a gravação incremental, consultas indexadas de caixa, competência e patrimônio (`queries`), filtros do livro (`search`), reclassificação em lote (`edits`), configuração inicial (`onboarding`), faturas e parcelas (`cards`), recorrências (`recurrence`), fechamento mensal (`periods`), configurações (`settings`), migrações de esquema |
| `importing/` | Fonte em memória (PDF/CSV/OFX), parsers por layout, pipeline de importação, sugestões por IA local |
| `investments/` | Posições, avaliações e fluxos (`service`), resultados (`performance`), simulador, lotes e negociações (`trades`), TWR/XIRR/Dietz (`returns`), notas de corretagem (`notes`), índices locais (`benchmarks`) |
| `charts/` | Dados dos gráficos com proveniência (`data`) e renderização Matplotlib com tooltip e inspeção (`render`) |
| `vault/` | Cofre SQLCipher (gravação completa ou incremental), worker transitório, backup, troca de senha e desbloqueio da tela |
| `ui/` | Janela principal e uma página por seção do `07`; edição completa de lançamentos (`operation_edit`), assistente de primeiro uso (`setup_wizard`), ajuda F1 (`help`), bloqueio visual (`idle_lock`) |
| `diagnostics.py` | Registro técnico só com códigos e ganchos globais de exceção (`14` §2) |
| `exports.py` | Exportações explícitas (CSV do livro e JSON de intercâmbio) |
| `registry.py` | Lista explícita dos módulos que registram tipos persistidos e guardas |

Persistência: o domínio vira registros `(id, tipo, JSON)` dentro do snapshot. Decimais são gravados como texto e datas em ISO. Abrir um cofre exige conhecer todos os tipos; um tipo desconhecido (versão mais nova) é recusado.

## 2. Por fase

### Fase 1 — Fundamentos
- Integrantes, contas (corrente, poupança, dinheiro, corretora, investimento, empréstimos), cartões com adicionais, categorias hierárquicas sem ciclos.
- Partidas dobradas, com débito positivo e crédito negativo. A operação precisa equilibrar por moeda e usar centavos em BRL; partidas zero e referências inexistentes são recusadas.
- Datas separadas: ocorrência, lançamento, competência, vencimento e liquidação. Data ausente continua desconhecida.
- Saldo de abertura vai para o patrimônio de abertura, nunca para receita.
- Correção, cancelamento e estorno exigem motivo e guardam a versão anterior.
- Telas: visão geral, livro financeiro, contas e cartões, documentos.
- Testes: TA-15, TA-16, TA-18, TA-32 e RF-22 (`tests/test_domain_ledger.py`).

### Fase 2 — Documentos
- Pipeline do `05` §3:
  - tipo real, tamanho e páginas;
  - hash, com recusa de arquivo repetido (TA-12);
  - extração em memória, com senha de PDF usada uma vez;
  - PDF escaneado vira pendência;
  - detecção de layout, com escolha pelo usuário quando ambíguo;
  - parser versionado e evidências com página e região;
  - conciliação, duplicatas e sugestões;
  - revisão lado a lado;
  - aprovação.
- Duplicatas:
  - mesmo `FITID`;
  - extratos sobrepostos, contando linhas iguais (TA-13 e TA-14);
  - o outro lado de uma transferência ou de um pagamento de fatura;
  - parcelas já registradas.
- Divergência de total bloqueia a aprovação, salvo com motivo. Aprovação parcial também exige motivo.
- IA opcional: só Ollama em loopback, sem modelos em nuvem, só descrições enviadas e saída validada contra as categorias. O aplicativo funciona por completo sem ela (TA-29).
- Testes: `tests/test_importing.py` e `tests/test_ai.py`.

### Fase 3 — Finanças
- Ciclos de fatura (fechamento e vencimento), faturas calculadas com status e comparação com o total do documento.
- Parcelamento com política explícita de competência: mês da compra ou distribuída nas parcelas. Centavos residuais vão para as primeiras parcelas.
- Recorrências, cujas previsões nunca mexem em saldos. A vinculação ao realizado é confirmada pelo usuário (TA-17).
- Fechamento mensal com resumo, pendências justificadas, bloqueio de alterações e reabertura com motivo (TA-19).
- Testes: `tests/test_finance.py`.

### Fase 4 — Investimentos essenciais
- Posições por valor ou por quantidade.
- Avaliações por data com natureza bruta ou líquida. Fontes divergentes são preservadas e uma é escolhida, sem média (TA-26).
- Aportes, proventos e resgates com imposto retido, imposto a pagar depois e taxas (TA-28).
- Resgate só com o líquido fica incompleto até ser discriminado.
- Resultado do período, retorno simples, resultados realizado e não realizado, composição parcial (TA-36) e simulador com regras parametrizadas.
- Gráficos obrigatórios do `07` §4.
- Testes: exemplos A–F como especificação (TA-20 a TA-25, `tests/test_investments.py`).

### Fase 5 — Carteira detalhada
- Lotes, compras e vendas. O método de custo depende da classe (custo médio ou lote mais antigo) e fica sempre registrado. Venda a descoberto é recusada.
- Desdobramento, bonificação e posição inicial.
- TWR sem interpolação (TA-27), XIRR que recusa ausência de solução e múltiplas raízes, e Dietz como estimativa.
- Índices locais importados de arquivo.
- Notas de corretagem aprovadas viram negociações:
  - custos rateados exatamente pelo valor;
  - IRRF atribuído às vendas;
  - caixa lançado na data de liquidação.
- O parser SINACOR fecha o líquido exatamente nas 8 notas públicas de interesse.
- Testes: `tests/test_portfolio.py` e `tests/test_fixtures_terceiros.py` (este é pulado até os PDFs serem copiados).

### Fase 6 — Consolidação
- Backups como cópia da revisão salva, nunca sobrescritos, com retenção que preserva os fixados.
- Restauração para um destino separado (TA-07). Troca de senha no worker; backups antigos mantêm a senha antiga.
- Limpeza de candidatos de salvamento interrompido (`11` P7).
- Exportações explícitas com aviso (RF-20).
- Backup do original antes de gravar um cofre migrado (RNF-07).
- Lembrete de alterações não salvas e caminhos recentes opcionais, guardados fora do cofre.
- Catálogo de cobertura por layout na tela de configurações.
- Atalhos Ctrl+1..9.
- Instalador Inno Setup **opcional**.
- Teste de jornada completa com rede externa bloqueada (TA-30, `tests/test_journey.py`).

### 2.1 Depois da fase 6

- **Fase 8 (desempenho):**
  - salvar grava só os registros e documentos alterados numa cópia do arquivo cifrado, verifica a cópia inteira e substitui de forma atômica;
  - abrir entrega os registros como JSON para o domínio interpretar uma única vez e autentica todas as páginas, inclusive as de índice;
  - consultas usam um índice por data com somas acumuladas;
  - o livro usa tabela virtual.
- **Fase 9 (uso diário):**
  - assistente de primeiro uso;
  - edição completa de lançamentos (datas, competência, partidas, rateio por integrante), com motivo;
  - filtros por período, conta ou categoria, integrante, situação, origem e texto;
  - reclassificação em lote que nunca desfaz um rateio;
  - atalhos na revisão de importação que avançam para o próximo item;
  - ajuda F1;
  - bloqueio visual por inatividade, com senha conferida no worker;
  - importações em fila, que bloqueiam salvar e editar enquanto rodam.
- **Fase 10 (robustez):** fuzzing, registro técnico, licenças e SBOM (`14`).
- **Fase 7 (preparação):** validador de layouts com corpus privado e rastreabilidade dos TAs (`15`).
- Testes: `test_incremental_save`, `test_edits`, `test_ledger_view`, `test_onboarding`, `test_daily_use`, `test_fuzz`, `test_diagnostics`, `test_licenses`, `test_layout_validation`, `test_acceptance_gaps`.

### 2.2 Rotina da família (fases 11 e 12, primeira parte)

- **Regras de categoria** (`importing/rules.py`):
  - "a descrição contém X → categoria Y", opcionalmente só para uma conta ou cartão;
  - comparação sem acentos e sem diferenciar maiúsculas;
  - a mais específica vence: primeiro a limitada à conta, depois o texto mais longo;
  - ordem de prioridade: escolha à mão > regra do usuário > histórico > regras padrão (`KEYWORD_RULES`), sendo que a escolha à mão nunca é sobrescrita;
  - ao escolher a categoria de um item na revisão, a tela oferece criar a regra, com texto sugerido sem números nem parcelas; Ctrl+R faz o mesmo;
  - o diálogo mostra quantos itens pendentes a regra pegaria e pode aplicá-la na hora;
  - as regras são geridas em Contas e cartões › Regras; desativar mantém o histórico.
- **Orçamento** (`domain/budget.py`, página Orçamento):
  - valor planejado por categoria de despesa e mês;
  - o realizado segue a competência: compra no cartão conta no mês da compra, o pagamento da fatura não repete a despesa e o estorno reduz;
  - o plano da categoria-mãe cobre as subcategorias;
  - estados "dentro", "perto do limite" (≥ 90%) e "estourado", sempre em texto;
  - "sem orçamento" soma o que foi gasto fora do plano; o plano pode ser copiado do mês anterior;
  - quando um lançamento estoura um plano, a barra de status avisa na hora.
- **Avisos ao abrir** (`domain/alerts.py`, painel "Atenção" na Visão geral):
  - faturas a vencer em 7 dias ou vencidas há até 31 dias;
  - contas recorrentes a vencer e previsões atrasadas;
  - orçamento estourado ou perto do limite;
  - itens importados aguardando revisão e documentos sem layout.

  Ao abrir o cofre, a janela vai para a Visão geral e resume na barra de status. O painel pode ser ocultado até a próxima abertura, e cada aviso tem um botão para a tela onde se resolve. A Visão geral mostra na barra lateral quantos avisos pedem atenção.
- **Desfazer/refazer** (`undo.py`, menu Editar):
  - Ctrl+Z e Ctrl+Shift+Z (ou Ctrl+Y) para o que ainda não foi salvo;
  - cada ação do usuário é um passo; o `Ledger` mantém um diário das alterações (objeto anterior e novo), e documentos importados entram e saem junto;
  - desfazer devolve os objetos exatos de antes e remove do histórico só as entradas que nunca chegaram ao cofre;
  - ao salvar, os passos gravados deixam de ser desfazíveis; as edições feitas durante o salvamento continuam;
  - bloqueado enquanto uma importação ou operação do cofre está em andamento;
  - no salvamento incremental, o que foi desfeito vira exclusão.
- Testes: `test_rules`, `test_budget`, `test_alerts`, `test_undo` e `test_family_routine`. O `conftest` descarta as janelas ao fim de cada teste: dezenas de janelas acumuladas faziam o Qt repolir widgets meio destruídos ao trocar o tema e derrubavam o interpretador.

## 3. Cobertura de importação

O catálogo fica em Configurações e em `importing/parsers/__init__.py`.

| Layout | Origem do conhecimento | Validado com documentos reais |
|---|---|---|
| `nubank-cartao-pdf`, `itau-cartao-pdf`, `bradesco-cartao-pdf`, `itau-extrato-pdf` | Descrições públicas (`12` §3) | Não |
| `nubank-cartao-csv`, `nubank-conta-csv` | Formatos de exportação descritos publicamente | Não |
| `ofx-generico` | Padrão OFX 1.x/2.x | Não |
| `sinacor-nota-pdf` | 8 notas públicas anonimizadas | Sim |

Um layout só passa a ser declarado suportado depois de conferido com documentos autorizados (`08` §7). Até lá, cada lote importado mostra o aviso correspondente.

## 4. Desempenho medido (Linux, referência)

Cenário: 50 mil lançamentos com histórico e 250 MiB de PDFs.

| Métrica | Fase 6 | Agora |
|---|---|---|
| Salvar | ~21 s | ~3,7 s (incremental) |
| Abrir | ~10–15 s | ~8,7 s |
| Pico de RAM da UI | ~760 MiB | ~580–690 MiB |
| Pico de RAM do worker | ~820 MiB | ~50 MiB ao salvar |
| Atualizar ou filtrar o livro | — | ≤ 0,2 s |

A abertura continua acima da meta de 5 s. O piso é decifrar o arquivo e interpretar as 50 mil operações (`09` §1.4).

## 5. Formato de intercâmbio (exportação JSON, versão 1)

- Campos de topo:
  - `formato = "opesvault-intercambio"`;
  - `versao_formato = 1`;
  - `versao_esquema` (esquema do domínio);
  - `exportado_em` (instante UTC);
  - `entidades`.
- Cada entidade tem `id` (UUID estável), `tipo` (`member`, `account`, `operation`, `valuation`…) e `dados`.
- Valores decimais vêm como texto com ponto e precisão integral; datas em `AAAA-MM-DD`.
- Bytes dos documentos não são incluídos. O arquivo não tem criptografia.

## 6. Pendências

O planejamento das próximas fases, com critérios de saída, está no `09` §1.2.


1. **Gates do Windows** G0–G7 (`11` §4): presumidos, não executados.
2. **Abertura** acima da meta de 5 s (`09` §1.4).
3. **Documentos reais** de faturas, extratos, CSV e OFX para validar os layouts sintéticos. Notas de corretagem de terceiros aguardam a cópia manual (`tests/fixtures/terceiros/notas_corretagem/README.md`).
4. **Fora da entrega atual:**
   - OCR;
   - moedas estrangeiras com câmbio;
   - tabelas fiscais por classe;
   - derivativos e mercado futuro;
   - planilhas `.xlsx`.
5. **Distribuição:** versões fixadas após G1, assinatura do instalador e ícone (`14` §5).
