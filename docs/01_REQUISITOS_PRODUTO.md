# Requisitos de produto

Versão 1.0 • 01/10/2026 • Vinculado ao documento mestre.

## 1. Usuários e limites

Um operador usa o aplicativo em um computador por vez. Integrantes representam pessoas da família, titulares e responsáveis pelos lançamentos. A senha compartilhada concede acesso integral ao cofre. O nome selecionado como operador identifica ações, mas não constitui autenticação individual nem prova de autoria.

Cofres são independentes, inclusive quando representam a mesma pessoa em cenários distintos. Não haverá comparação entre famílias sem uma futura funcionalidade explicitamente autorizada.

## 2. Requisitos funcionais

| ID | Requisito obrigatório | Evidência de aceitação |
|---|---|---|
| RF-01 | Criar, abrir, fechar e selecionar cofres | Alternar cofres elimina a sessão anterior e pede nova senha |
| RF-02 | Pedir senha em cada salvamento | Senha incorreta ou cancelamento não alteram o arquivo existente |
| RF-03 | Cadastrar integrantes e contas individuais/conjuntas | Consulta distingue titularidade de autoria de lançamento |
| RF-04 | Cadastrar cartões e adicionais | Compra mantém portador e vínculo com fatura |
| RF-05 | Importar vários PDFs, CSV e OFX | Falha de um arquivo não apaga a revisão dos demais |
| RF-06 | Revisar extração com documento original | Cada item apresenta fonte e permite correção |
| RF-07 | Aprovar importações explicitamente | Itens pendentes ficam fora dos resultados realizados |
| RF-08 | Conciliar saldos e faturas | Divergências são mostradas, nunca ajustadas silenciosamente |
| RF-09 | Detectar arquivos e operações repetidos | Nova importação identifica sobreposição sem apagar compras legítimas |
| RF-10 | Incluir receitas, despesas e transferências manuais | Registro inclui origem manual e datas relevantes |
| RF-11 | Cadastrar recorrências e parcelamentos | Previsão vinculada ao realizado não duplica valores |
| RF-12 | Consultar caixa, competência e patrimônio | Uma mesma operação produz visões coerentes |
| RF-13 | Fechar e reabrir meses | Reabertura exige motivo; alteração fica no histórico |
| RF-14 | Cadastrar ativos e movimentações | Posição, custo e caixa reconciliam |
| RF-15 | Inserir avaliações por data, repetidamente | Avaliação nova preserva a série histórica |
| RF-16 | Registrar resgate com imposto e taxas | Líquido recebido reconcilia com o extrato |
| RF-17 | Simular resgate e imposto | Simulação é identificada e não lança movimentação |
| RF-18 | Exibir gráficos interativos locais | Tooltip informa unidade, origem, data e regime |
| RF-19 | Criar e restaurar backups cifrados | Restauração preserva documentos, relações e versões |
| RF-20 | Exportar dados ou gráficos por ação explícita | Usuário vê que a saída pode estar sem criptografia |
| RF-21 | Funcionar sem IA | Cadastro, revisão e cálculo seguem disponíveis |
| RF-22 | Corrigir registros já aprovados | Histórico preserva versão anterior e motivo |

## 3. Fluxos prioritários

### Primeiro uso

Criar cofre; informar senha e confirmação; cadastrar família, contas e saldos de abertura; salvar; confirmar que o arquivo pode ser reaberto. Saldos iniciais recebem contrapartida patrimonial de abertura, sem virar receita do mês.

### Revisão mensal

Selecionar documentos; conferir titulares e períodos; resolver duplicatas; conciliar valores; aprovar itens; salvar com senha; revisar visão de caixa e competência; fechar período quando não houver pendência relevante.

### Investimento por avaliações manuais

Cadastrar investimento; informar capital/custo conhecido e data inicial; lançar valores observados em datas posteriores; registrar aportes, distribuições e resgates à parte; consultar evolução e resultado. Se o custo inicial for desconhecido, permitir acompanhar valor de mercado sem inventar lucro acumulado ou base de imposto.

### Resgate

Selecionar posição e data; indicar valor bruto ou quantidade; discriminar imposto, taxas e custo atribuído; conferir líquido; vincular conta de destino; salvar. Quando só o líquido for conhecido, registrar dado incompleto e pedir complemento, sem inferir imposto como zero.

## 4. Requisitos não funcionais

| ID | Requisito |
|---|---|
| RNF-01 | Operação offline completa após instalação de dependências e modelos |
| RNF-02 | Nenhum conteúdo financeiro em logs técnicos em texto claro |
| RNF-03 | Sem senha/chave deliberadamente persistida entre abrir e salvar |
| RNF-04 | Operações monetárias exatas, com política de arredondamento explícita |
| RNF-05 | Interface responsiva; extração e cálculos demorados fora da thread visual |
| RNF-06 | Cancelamento previsível e isolamento de falhas por documento |
| RNF-07 | Formato de cofre versionado; migração protegida por backup |
| RNF-08 | Navegação por teclado, contraste adequado e escalonamento do Windows |
| RNF-09 | Bloqueio de edição concorrente e detecção de arquivo substituído |
| RNF-10 | Relatórios reproduzíveis sem reconsultar modelos de IA |

Meta inicial de ensaio, ainda não validada: 50 mil lançamentos e até 250 MiB de PDFs incorporados em máquina Windows de referência com 16 GiB de RAM. A arquitetura mantém uma sessão em memória; limite real e consumo máximo são gate técnico da fase inicial. Mostrar volume estimado antes de importações que possam exceder a capacidade ensaiada. GPU e VRAM só afetam recursos opcionais de IA.

## 5. Estados de qualidade

Estados distintos: extraído; necessita revisão; aprovado na sessão; salvo; conciliado; fechado. Uma aprovação não significa que o arquivo foi salvo. Uma conciliação de total não significa que descrições e categorias foram auditadas.

Relatórios identificam dados incompletos, avaliações antigas, fontes manuais e estimativas. Não há selo genérico de “100% correto”.
