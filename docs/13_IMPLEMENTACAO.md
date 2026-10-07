# Implementação das fases 1 a 10

Versão 1.1 • 02/10/2026. Registra o que foi construído em cada fase do roadmap (`09` §1), como os critérios de saída foram verificados e o que continua pendente. A fase 0 está em `11`. Das fases 7 a 10 foi feito o que não depende do Windows nem de documentos reais (§2.1); o andamento detalhado está no `09` §1.4.

> **07/10/2026:** documento histórico. O código Python descrito aqui foi removido (está no histórico do git); a implementação em vigor é a web (`18` §10).

**Escopo da verificação:** tudo foi testado em Python no Linux, com testes automatizados e interface em modo `offscreen`. Os gates do Windows continuam presumidos aprovados (`11` §4). Os layouts de faturas e extratos são sintéticos até haver documentos reais.

## 1. Mapa do código

| Pacote | Conteúdo |
|---|---|
| `domain/` | Dinheiro exato (`money`), entidades (`model`), agregado `Ledger` com invariantes e coleções rastreadas (`tracking`), histórico e registro de alterações para a gravação incremental, consultas indexadas de caixa, competência e patrimônio (`queries`), filtros do livro (`search`), reclassificação em lote (`edits`), configuração inicial (`onboarding`), faturas e parcelas (`cards`), recorrências (`recurrence`), fechamento mensal (`periods`), configurações (`settings`), migrações de esquema |
| `importing/` | Fonte em memória (PDF/CSV/OFX), parsers por layout, pipeline de importação (fluxo em `pipeline`, com `store`, `checks`, `suggestions` e `approval` por etapa), regras do usuário (`rules`), categorias aprendidas com o uso (`learning`), sugestões por IA local de categoria (`ai_suggestions`) e de nome de estabelecimento (`ai_merchants`) |
| `investments/` | Posições, avaliações e fluxos (`service`), resultados (`performance`), simulador, lotes e negociações (`trades`), TWR/XIRR/Dietz (`returns`), notas de corretagem (`notes`), índices locais (`benchmarks`) |
| `ai/` | Cliente do Ollama local (`ollama`: só loopback, lotes, validação, porta, GPU, conversa com ferramentas) e as instruções versionadas de cada tarefa (`prompts`) |
| `assistant/` | Assistente: ferramentas no formato do MCP (`tools`), leituras (`reads`), alterações preparadas para aprovação (`edits`) e a conversa passo a passo com o limite de respostas inválidas (`conversation`) |
| `charts/` | Dados dos gráficos com proveniência (`data/`: modelo e tabela de valores, caixa, gastos, patrimônio, investimentos) e renderização Matplotlib com tooltip e inspeção (`render`) |
| `vault/` | Cofre SQLCipher (gravação completa ou incremental), worker transitório, backup, troca de senha e desbloqueio da tela |
| `ui/` | Janela principal (`main_window`, com as partes em `shell/`), preferências do computador (`preferences`) e uma página por seção do `07` (as grandes em pacotes: `pages/ledger`, `investments`, `tax`, `imports`, `accounts`); edição completa de lançamentos (`operation_edit`), assistente de primeiro uso (`setup_wizard`), ajuda F1 (`help`), bloqueio visual (`idle_lock`) |
| `diagnostics.py` | Registro técnico só com códigos e ganchos globais de exceção (`14` §2) |
| `exports.py` | Exportações explícitas (CSV do livro e JSON de intercâmbio). No CSV, texto livre que começa com `=`, `+`, `-`, `@`, tabulação ou retorno de carro ganha um `'` na frente, para a planilha não o executar como fórmula (`19` §12.1, achado 12) |
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

### 2.3 Revisão de funcionalidades de 03/10/2026 (`09` §1.3 E)

Pedido do usuário: o que um aplicativo de finanças precisa ter e não tínhamos, com gráficos e tabelas de valores na mesma tela, recolhíveis, e não em abas.

- **Gráfico + tabela de valores** (`ui/chart_panel.py`, `charts.data.table_rows`): Relatórios (todos os gráficos), Visão geral (Mês a mês, 12 meses), Orçamento (planejado × realizado por mês), Contas (saldo no fim de cada mês, com o saldo informado pelo banco), Faturas (gráfico sobre a tabela), Financiamentos (gráfico e cronograma) e Investimentos (seis abas viraram seções recolhíveis).
- **Saldo projetado** (`domain/projection.py`): saldo de hoje + recorrências pendentes + faturas (pela conta de pagamento do cartão, com recorrências lançadas no cartão) + parcelas de financiamento; atrasados contam hoje. Aviso "Saldo previsto negativo" em até 30 dias. Relatórios › Saldo projetado (30/60/90 dias).
- **Comparações** (`domain/comparisons.py`): mês × média de 3/6/12 meses × mesmo mês do ano anterior, por categoria e nos totais; meses antes do primeiro registro não entram. Visão geral (totais e categorias que mais subiram) e Relatórios › Comparação com a média.
- **Financiamentos** (`domain/loans.py`, Contas e cartões › Financiamentos): SAC e Price, taxa ao mês ou ao ano (efetiva), seguros por parcela, entrada da dívida como saldo de abertura ou dinheiro recebido, pagamento separando amortização/juros/encargos, amortização antecipada com simulação (reduzir prazo ou parcela). Aviso de parcela a vencer ou vencida.
- **Marcadores** (`domain/tags.py`): adicionar/remover no Livro (Ações › Marcadores…), compra parcelada marcada inteira, permitido em mês fechado, renomear, filtro no Livro e Relatórios › Marcadores.
- **Reembolsos e acertos** (`domain/sharing.py`, página Reembolsos e acertos): reembolso a receber marcado no Livro, recebimento como estorno das categorias, negativa; saldo entre integrantes a partir do rateio e de quem pagou, com as despesas que o formam e o registro de acertos.
- **Assinaturas e contas fixas** (`domain/subscriptions.py`, Recorrências): custo anual, última cobrança, "Valor mudou" (também como aviso) e cobranças que parecem recorrentes, com "Criar recorrência…" preenchido.
- **Calendário** (`domain/agenda.py`, página Calendário): grade do mês, totais a pagar/atrasado/pago/a receber, lista por dia e "Abrir…" que leva ao ponto de pagamento ou vínculo.
- **Indicadores** (`domain/indicators.py`, Visão geral): poupança do mês e de 12 meses, despesas fixas, renda comprometida com parcelas e reserva em meses de despesa; "—" com o motivo quando os dados não permitem.
- **Conferência de saldo** (`domain/balance_checks.py`, Contas): saldo do extrato numa data contra o do aplicativo; diferença calculada na hora, coluna "Conferido com o banco" e aviso enquanto diverge.
- **Despesas dedutíveis** (`domain/deductibles.py`): marcação da categoria (herdada pelas subcategorias) e Relatórios › Despesas dedutíveis por pessoa e ano.
- Novos tipos persistidos: `loan_plan`, `loan_payment`, `loan_prepayment`, `operation_tags`, `reimbursement`, `member_settlement`, `balance_check`, `deductible_category` (em `registry.MODULES`).
- Testes: `test_planning` (domínio, 24) e `test_planning_ui` (interface). `scripts/capturar_telas.py` inclui dados de demonstração de todas as funcionalidades novas.

Pendências do `09` §1.3 A–D feitas no mesmo dia:

- **Comprovantes** (`domain/attachments.py`, Livro › Ações › Anexar comprovante): PDF, PNG ou JPEG reconhecidos pelos primeiros bytes, até 25 MB, guardados como documentos do cofre (o mesmo arquivo vira um só documento); vínculo ao lado da operação, permitido em mês fechado; Documentos mostra "Comprovante" e exibe imagens em memória.
- **Visão por integrante** (Visão geral › "Visão de"): competência pelas partes do integrante; caixa, saldos e patrimônio pelas contas de que é titular (conjuntas inteiras, dito na legenda).
- **Filtros salvos** (`domain/saved_filters.py`, Livro › Filtros salvos): no cofre; período personalizado não é salvo.
- **Arrastar arquivos** em qualquer tela leva à Importação (a tela Importar já aceitava).
- **Relatório do mês e fechamento do ano em PDF** (`exports.monthly_report_html`, `annual_report_html`, `ui/pdf_export.py`): HTML com textos escapados, convertido em PDF em memória (`QTextDocument` + `QPdfWriter`), só no caminho escolhido e depois do aviso.
- **Verificação de backup** (Cofre › Verificar backup): abre o backup no worker (senha digitada nele), autentica as páginas, lê o livro e compara com o cofre aberto (mesmo cofre, revisões atrás); aviso "Faça um backup" ou "Último backup há N dias" (≥ 30) a partir da pasta de backups.
- **Lançamentos suspeitos** (`domain/anomalies.py`): mesma conta, valor e descrição em até 3 dias; valor acima de 3× a mediana da categoria no ano anterior (≥ 5 amostras); verificados nos últimos 60 dias; "Está certo" silencia. Avisos com "Ver lançamentos".
- **Estabelecimentos** (`domain/merchants.py`): limpeza determinística da descrição (prefixos de adquirentes, códigos, sufixos), nome aprovado pelo usuário guardado ao lado; Relatórios › Despesas por estabelecimento.
- **Metas** (`domain/goals.py`, página Metas): patrimônio líquido ou saldo de contas escolhidas, progresso, quanto falta por mês até o prazo, ritmo recente e mês em que a meta é alcançada nesse ritmo; gráfico e tabela mês a mês.
- **Fechamento do ano** (`domain/annual.py`, Relatórios › Fechamento do ano): bens e dívidas em 31/12 com o ano anterior, receitas por categoria, proventos, imposto retido, ganhos realizados (resgates sem bruto ou custo ficam fora e são contados) e dedutíveis por pessoa no PDF.
- **Desempenho**: com 50 mil lançamentos, os avisos ao abrir levam ~1,2 s na primeira vez (quase tudo é o índice que a Visão geral já montava) e o resto é cache por estado do livro: histórico de faturas por cartão, ciclos de fatura (`lru_cache`) e suspeitas.
- **Não feito**: compactação do histórico (apaga versões; aguarda decisão) e os itens de IA do §1.3 D além do estabelecimento.
- Testes: `test_planning_more` (domínio) e os novos casos de `test_planning_ui`.

### 2.4 Imposto de renda (`09` §1.3 F)

Pedido do usuário: implementar os itens de relevância alta e média da pesquisa de funções de apps de IRPF. Pacote `opesvault/tax/`, página **Imposto de renda** (Acompanhamento). Material de apoio: nenhuma tabela, alíquota ou limite vem embutido.

- **CPF/CNPJ** (`tax/ids.py`, `records.set_identity`): dígitos verificadores; de estabelecimentos (quem recebeu), contas (instituição, credor) e categorias de receita (fonte pagadora). Só no cofre.
- **Declarantes e dependentes** (`member_tax_info`): CPF, nascimento, quem declara quem; o seletor "Projeto inteiro"/declarante filtra todas as fichas.
- **Fichas** (`tax/declaration.py`): tributáveis de PJ por fonte (bruto do contracheque ou líquido, com aviso; 13º e IR do 13º à parte; INSS), isentos, exclusivos e Carnê-Leão pela natureza escolhida (categoria ou investimento), pagamentos efetuados (pago, parcela não dedutível, dedutível, comprovantes), bens pelo custo e dívidas em 31/12.
- **Informes** (`tax/statements.py`): leitura genérica do PDF (ano, CNPJ, linhas por rótulo e por seção), fora da thread visual, revisão linha a linha, original guardado cifrado; comparação campo a campo com o registrado (saldos, rendimentos, IR retido, INSS, 13º).
- **Documentos do ano** (`tax/checklist.py`) e **pendências** (`tax/issues.py`, com "Resolver…" que abre a correção); lembretes de DARF (renda variável e Carnê-Leão) e da temporada da declaração em Atenção, com cache por estado do livro.
- **Renda variável** (`tax/variable_income.py`): vendas de ações, ETF e FII por mês e tipo (comuns, day trade, FII), isenção pelo limite informado, prejuízo compensado nos meses seguintes, imposto, IR na fonte, DARF e vencimento; DARF pago registrado como despesa.
- **Simplificada × completa** (`tax/simulation.py`): tabela anual, desconto simplificado e limites informados; INSS, saúde, instrução até o limite por pessoa, previdência privada até o percentual, pensão e dependentes.
- **Contracheque**: bruto, IR retido e INSS por depósito (página e Livro › Ações › Detalhar rendimento).
- **Relatório em PDF** (`exports.tax_report_html`) com fichas, simulação e pendências.
- Testes: `test_tax` (domínio, 15), `test_tax_ui` (interface, 5) e fuzzing do leitor de informes.

### 2.5 Contas bancárias e características de investimento

Pedido do usuário: contas bancárias com banco, código, agência e conta; titular único ou conjunta (principal e secundário); corrente, poupança, investimentos ou qualquer mistura; valores numa data integrados ao app; investimentos com características próprias; códigos de listas pré-definidas, como no IRPF.

- **Listas embutidas** (`opesvault/catalogs/`): 513 bancos e instituições de pagamento com código COMPE, ISPB e CNPJ (`banks.py`, gerado por `scripts/atualizar_bancos.py` a partir de lista pública compilada do Banco Central); grupos e códigos de Bens e Direitos do IRPF e códigos de rendimentos isentos e de tributação exclusiva usados por investimentos (`irpf.py`). Escolhidos em listas com busca por código ou nome (`ui/catalog_widgets.py`); o grupo e código de Bens e Direitos deixaram de ser digitados também no Imposto de renda.
- **Conta bancária** (`domain/banking.py`, aba Contas e cartões › Contas bancárias): cria ou reaproveita a conta corrente e a poupança no livro, mantém titulares (o primeiro é o principal), instituição e número nelas e grava o CNPJ do banco para as fichas. A janela de conta comum também passou a ter titular e segundo titular.
- **Valores em uma data**: conferência por conta, ajuste opcional ao saldo do banco e avaliação dos investimentos; tudo aparece em saldos, patrimônio, relatórios, conferências e no Imposto de renda.
- **Características do investimento** (`investments/profile.py`): tipo IRPF (sugere a classe e a tributação), conta bancária onde está, emissor e CNPJ, indexador e taxa ("110% do CDI", "IPCA + 6,5% a.a."), aplicação, vencimento, liquidez, tributação, código do rendimento e FGC. Novo investimento pela conta bancária (o dinheiro pode sair da corrente dela) ou Investimentos › Mais › Características.
- **Imposto de renda**: corrente 06.01 e poupança 04.01 com a discriminação "agência e conta"; investimentos com o tipo e a discriminação montados das características, CNPJ do banco da lista; a natureza e o código do rendimento vêm do código escolhido.
- Testes: `test_banking` (domínio, 7) e `test_banking_ui` (interface, 4).

### 2.6 Refinamentos de 03/10/2026 (revisão de telas e diálogos)

Revisão de todas as telas, abas e diálogos em 1920×1080, 1280×800, 900×640 e no escuro.

- **Vencimento de investimentos**: a data de vencimento das características aparece no Calendário ("Vencimento — CDB…", com o valor esperado de volta) e nos avisos ("Investimento vence: …", "Investimento venceu: … registre o resgate ou a renovação"); o aviso leva ao investimento (`InvestmentsPage.reveal`). Novo investimento fica selecionado e lembra onde descrever tipo, taxa e vencimento.
- **Largura mínima**: a janela voltou a caber em 900 px (a aba Contas bancárias exigia 926): ações do cabeçalho quebram linha, a barra da aba usa `flow_row`, os painéis de Importar ficaram mais estreitos e a barra lateral mostra os nomes inteiros.
- **Tabelas**: ordem inicial correta (antes de Z para A pela primeira coluna), barras de rolagem do tema, contador da barra lateral sem sobrepor o nome, competência "out/2026" no Livro, colunas de Importar que repartem a largura.
- **Seleção automática**: documento, fatura em aberto mais antiga e investimento ficam escolhidos ao abrir a aba, sem área de detalhe vazia.
- **Avisos**: em largura estreita a ação desce para baixo do texto; valores "R$ 1.000,00" não quebram linha.
- **Diálogos**: o formulário rola quando não cabe na tela; listas editáveis só com "Fechar"; transferência e acerto já propõem destino e credor diferentes da origem; instituição com sugestões da lista de bancos; tabela do ano com colunas que repartem a largura.
- **Outros**: Recorrências lado a lado em telas largas, Configurações com largura de leitura, saldo zero exibido como "R$ 0,00" e aba "Todas as contas".
- Testes: `test_banking` (vencimento no calendário e nos avisos) e `test_banking_ui` (o aviso abre o investimento).

### 2.7 Segunda rodada de refinamentos (03/10/2026)

- **Nomes longos**: `ElidedLabel` no nome do projeto e do arquivo na barra, no documento em revisão, no investimento e na conta selecionados e no título do visualizador de PDF. Um nome de arquivo longo alargava a janela inteira.
- **Investimento selecionado**: características numa linha, números principais (último valor, custo remanescente, não realizado com sinal de cor e texto, vencimento com dias que faltam, em destaque a menos de 30 dias) e, abaixo, como o resultado foi calculado.
- **Gráficos**: legenda na linha do título ou numa linha própria quando falta largura, notas que quebram linha, meses na horizontal, segunda escala para séries pequenas (financiamento: saldo à esquerda, juros e amortização à direita); a dica de um ponto fica sobre a série certa.
- **Tabelas**: a seta de ordenação deixou de reservar ~22 px em cada coluna; a tabela de faturas cabe em 1280 px sem rolagem lateral.
- **Mensagens**: orientações curtas foram para a barra de status em vez de caixas de diálogo.
- **Refatoração**: `select_id` substituiu onze cópias do laço que procurava a linha de um objeto; `fit_columns` mede as colunas em todas as tabelas.
- Testes: `test_ui_refinements` (nome cortado, cabeçalho que quebra linha, colunas, janela de 900 px com nome longo, segunda escala, legenda e notas, `select_id`, aviso em vez de diálogo), `test_banking_ui` (novo investimento selecionado, números do investimento) e `test_ui_design` (a janela cabe em 900 px, não mais 1000).

### 2.8 Organização do código, testes de todas as telas e regras que aprendem (03/10/2026)

- **Testes de todas as telas** (`tests/test_every_screen.py`, com o cofre de demonstração em `tests/demo_vault.py`, o mesmo das capturas): TA-31 em todas as páginas, abas, combos e dicas; cada botão e item de menu acionado com e sem seleção e num cofre vazio, com diálogos cancelados; largura de 900 px com dados; nada de cor fixa, `QSettings` fora de `ui/preferences.py` ou `findData`. Achou e corrigiu:
  - nomes de contas, integrantes e marcadores que ficavam nos filtros do Livro depois de fechar o cofre;
  - a resposta do "Verificar Ollama" tocando um botão de uma janela já destruída (agora `while_alive`);
  - durante a refatoração, um sinal que recebia o índice do combo e um preenchimento que religava sinais no meio de uma atualização em lote.
- **Combos por valor**: `QComboBox.findData` compara objetos por identidade; a revisão de importação mostrava "(escolha)" num lote que já tinha cartão, e as categorias dos itens voltariam a "(padrão)" depois de reabrir o cofre. Tudo passa por `select_combo`.
- **Preferências** num só ponto (`ui/preferences.py`); os testes desviam todas para um arquivo temporário (antes, seções recolhidas, colunas e bloqueio gravavam no perfil real durante os testes).
- **Divisão dos arquivos grandes**, sem mudar o comportamento:

  | Antes | Depois |
  |---|---|
  | `main_window.py` (1350 linhas) | `main_window.py` (montagem, menus, navegação, estado) e `ui/shell/` (barra lateral, boas-vindas, comandos do cofre, backups, bloqueio, recentes) |
  | `ledger_page.py` (1010) | `pages/ledger/`: página, `LedgerFilters` (um sinal por escolha), modelo, inspetor, comandos de linha |
  | `investments_page.py` (1051) | `pages/investments/`: página, `InvestmentDetail`, formulário, eventos, negociações |
  | `tax_page.py` (1074) | `pages/tax/`: página, `rows.py` (linhas das fichas sem Qt, com testes próprios), comandos, informes |
  | `import_page.py` (962) | `pages/imports/`: página, fila, revisão, IA local, rótulos; arquivo sumido antes da leitura vira aviso |
  | `accounts_page.py` (860) | `pages/accounts/`: página e abas sobre `PageTab` (contas bancárias, todas as contas, faturas, financiamentos, regras) |
  | `tax_dialogs.py` (896) | `ui/tax_dialogs/`: um módulo por ficha (pessoas, rendimentos, bens, informes, valores do ano) e campos comuns |
  | `components.py` (848) | `ui/components/`: básicos, layout, cabeçalho, seções, mês, decisões (`expanding`, sem uso, saiu) |

  Relatórios passaram a usar `select_id` (que agora também seleciona itens de lista).
- **Livro em janela estreita**: filtros e comandos (Filtros salvos, Ações, Detalhes) quebram linha juntos; em 900 px os filtros ocupam três linhas em vez de seis.
- **Regras que aprendem com o uso** (`importing/learning.py`): a categoria de cada lançamento ativo, pela chave do estabelecimento, sugere a de um item novo (depois das regras do usuário, antes das palavras-chave), segue a mudança de ideia da família (as 5 escolhas mais recentes decidem) e prefere as escolhas da mesma conta. Também propõe regras (a mesma categoria 3 vezes) e aponta regras contrariadas. Nada novo no cofre; o cálculo é refeito só quando lançamentos ou contas mudam (`Ledger.changes_of`): ~0,3 s para 20 mil lançamentos, 30 ms para sugerir 200 itens. O lançamento manual sugere a categoria pela descrição. O texto sugerido para regra deixou de carregar restos de parcelas ("LOJA TV (6x)" → "LOJA TV").
- **"Projeto" na tela**: os cofres de demonstração e de teste se chamavam "Família …" e apareciam na barra e nas capturas; agora "Projeto …". Um teste procura "família" em todo texto do programa (menos o prompt da IA local, que só o modelo lê) e em toda a tela aberta.
- Testes novos: `test_every_screen`, `test_learning`, `test_learning_ui`, `test_tax_rows`, `test_selection`, `test_background`, além de casos em `test_ledger_view`, `test_daily_use` e `test_rules`.

### 2.9 Terceira passada de organização e testes (04/10/2026)

- **Divisão, sem mudar o comportamento:**

  | Antes | Depois |
  |---|---|
  | `importing/pipeline.py` | fluxo de importação em `pipeline.py` (que reexporta os nomes públicos) e uma etapa por módulo: `store` (lotes, itens, evidências), `checks` (normalização, problemas, conferência, duplicatas), `suggestions` (palavras-chave e regras), `approval` (correção, rejeição, aprovação) |
  | `domain/ledger.py` | `TrackedDict`, `TrackedList` e `MISSING` em `domain/tracking.py` |
  | `charts/data.py` | `charts/data/`: `model` (pontos, séries, tabela de valores), `cash`, `spending`, `wealth`, `investments` |

- **Testes de propriedade** (`test_ledger_properties`, `test_money_properties`): sequências aleatórias com semente fixa de lançamentos, parcelas, reclassificações, cancelamentos e marcadores mantêm o livro balanceado, desfazem e refazem até o mesmo estado, sobrevivem a `to_records`/`from_records` e à gravação incremental; dinheiro arredonda para longe de zero e nunca passa por `float`.
- **Diálogos preenchidos como uma pessoa faz** (`test_planning_dialogs`, `test_tax_dialogs`, `test_ledger_commands`): cada comando de linha do Livro, os diálogos de planejamento e as fichas do imposto, com a validação do botão Confirmar, o resultado no livro e um único passo de desfazer.
- **Menu Cofre de ponta a ponta** (`test_vault_commands`, com o worker de desenvolvimento): criar, salvar e reabrir; backup manual, verificação e restauração como arquivo novo; cópia a cada salvamento com poda; troca de senha; exportações; arquivo que não é cofre recusado sem alteração.
- **Todos os gráficos** (`test_every_chart`): cada construtor público roda no cofre de demonstração e num vazio, só com `Decimal` ou desconhecido, e a tabela de valores diz o mesmo que as séries (uma linha por x, total só de fluxos). Um construtor novo precisa entrar no teste.
- **Defeitos encontrados e corrigidos:**
  - o Livro perdia a linha atual depois de uma alteração (marcador, estabelecimento), e o comando seguinte pedia "Selecione…";
  - Configurações gravavam o formulário antigo por cima de uma configuração mais nova ao salvar (a cópia automática ligada por outro caminho era desligada); agora só o que foi digitado na página é gravado;
  - taxas apareciam com zeros à direita ("7,500" em vez de "7,5") ao reabrir os valores do ano.
- Cobertura de linhas em ~88%; 607 testes.

### 2.10 IA local em todas as telas (04/10/2026)

- **Um núcleo para todas as tarefas** (`ai/ollama.py`): lotes, nova tentativa e cancelamento num executor só, usado por duas tarefas: categoria por descrição (`suggest_categories`) e nome legível de estabelecimento (`suggest_names`). As instruções ficam em `ai/prompts.py`, versionadas (`p4`, `m1`) e gravadas com cada sugestão.
- **Um contrato na interface** (`ui/local_ai.py`): `client_for` (escolha do cofre e porta deste computador), `AiRunRow` (progresso e Cancelar em segundo plano, resposta descartada se o cofre fechar) e `AiReviewDialog` (lista de conferência). Importar passou a usar a mesma linha de progresso.
- **Livro › IA local:** **Sugerir categorias…** e **Sugerir nomes de estabelecimentos…** para os selecionados (dois ou mais) ou todos os exibidos. A lista de conferência mostra uma linha por descrição (quantos lançamentos, categoria ou nome atual, sugestão); nada muda antes de aplicar, a aplicação é um passo de desfazer e a origem fica no histórico.
- **Novo lançamento:** **Perguntar à IA local** quando o histórico não conhece a descrição; a escolha feita à mão durante a consulta prevalece.
- **Configurações › IA local:** porta do Ollama (preferência deste computador) e **Verificar Ollama** dizendo quanto do modelo coube na GPU.
- **Melhorias na qualidade da resposta:** os exemplos vêm do livro como ele está (seguem correções, reclassificações e lançamentos manuais), as categorias vão com o pai (“Alimentação › Mercado”), e um nome sugerido só vale se for feito de palavras da própria descrição.
- **Defeito corrigido:** os exemplos enviados ao modelo vinham da categoria escolhida na aprovação de cada item importado; depois de uma reclassificação, a IA continuava aprendendo a categoria antiga, e lançamentos manuais não ensinavam nada.
- Testes novos: `test_ai_everywhere` (25 casos: validação de nomes, porta, GPU, exemplos, planejamento, Livro com lista de conferência, IA desligada, Ollama fora do ar, Novo lançamento e Configurações), além de `test_ai` e `test_flows` atualizados.

### 2.11 Assistente com ferramentas (04/10/2026)

Por decisão do usuário, a IA local ganhou as ferramentas do aplicativo (`05` §5): página **Assistente** (Acompanhamento), pacote `opesvault/assistant` e `OllamaClient.chat_tools`.

- **14 ferramentas de leitura** (resumo, contas, categorias, integrantes, busca com filtros, detalhe, despesas por categoria e por estabelecimento, resumo do mês, orçamento, marcadores, regras, itens importados pendentes, mostrar no Livro) e **8 de alteração** (reclassificar, marcador, nome de estabelecimento, regra, orçamento, despesa, receita, categoria de item importado), descritas no formato do MCP, sem servidor.
- **Toda alteração pede aprovação** na janela **Aprovar alteração**, que mostra o que muda; aprovada, vira um passo de desfazer. Recusada, nada muda.
- **Respostas inválidas** voltam ao modelo como erro; três seguidas interrompem a pergunta; no máximo 12 passos por pergunta.
- **Defeito evitado no caminho:** uma reclassificação aprovada depois de o lançamento ser cancelado dizia “aplicado” sem mudar nada; agora o modelo recebe o erro.
- Testes: `test_assistant` (27 casos: formato das ferramentas, leituras sem efeito, CPF/CNPJ fora, cada alteração só depois da aprovação, recusa, argumentos inválidos, três erros seguidos, limite de passos, dinheiro como `Decimal`, modelo sem ferramentas, tela com aprovação e recusa, fechamento do cofre).

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
