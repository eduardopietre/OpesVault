# OpesVault — Documento mestre

Versão documental: 1.0 • Data: 1 de outubro de 2026 • Idioma: português brasileiro.

Nome do produto: OpesVault. Extensão do cofre: `.opesvault`.

Este conjunto contém somente documentação. Não inclui implementação, scripts, esquema SQL, configurações executáveis ou promessa de compatibilidade já testada. A stack foi aprovada pelo solicitante; os detalhes de engenharia abaixo são especificações propostas para orientar o desenvolvimento e sua validação.

## 1. Objetivo

Aplicativo Windows com janela própria para organizar finanças de pessoas e famílias, importar PDFs bancários, conferir informações e acompanhar caixa, competência, patrimônio e investimentos. Todo processamento ocorre no computador. Cada família possui um cofre independente, protegido por senha compartilhada e transportável por backup.

O usuário poderá informar o valor de um investimento em diversas datas, visualizar sua evolução, registrar aportes e resgates e acompanhar resultado bruto e líquido. O aplicativo distinguirá avaliação patrimonial, movimentação de dinheiro e estimativa de imposto.

## 2. Decisões aprovadas

| Tema | Decisão |
|---|---|
| Plataforma | Windows; aplicativo com janela própria |
| Processamento | Integralmente local; nenhuma API externa de dados ou IA |
| Stack | Python, PySide6/Qt Widgets, SQLCipher, pdfplumber, pypdfium2, Pydantic, Decimal, Matplotlib, Ollama e pyside6-deploy/Nuitka |
| Documentos | Seleção de múltiplos PDFs; prioridade para texto selecionável |
| Conferência | Aprovação humana antes de incorporar extrações ao registro financeiro |
| Regimes | Caixa e competência, com visão patrimonial |
| Investimentos | Posições por ativo, custo, avaliações históricas e rentabilidade |
| Organização | Múltiplos cofres; uma pessoa ou família por cofre; múltiplos integrantes |
| Senha | Compartilhada por cofre; solicitada ao abrir e a cada operação de salvar |
| Conteúdo do cofre | Dados, PDFs originais, evidências de extração e histórico |
| Entrega atual | Apenas documentos de referência |

## 3. Correção necessária sobre memória

Digitar a senha ao salvar não garante, por si só, ausência de segredo na RAM. Uma conexão SQLCipher aberta precisa de material de chave; um documento exibido precisa de dados descriptografados. Python, Qt, bibliotecas nativas e o sistema operacional podem criar cópias cuja eliminação completa não pode ser comprovada pelo aplicativo.

A especificação adotada é: não guardar deliberadamente a senha ou a chave de longo prazo entre operações de abrir e salvar; usar operações criptográficas de curta duração, fechar conexões e encerrar seu processo ao terminar. Os dados da sessão permanecem em memória até o fechamento. Não anunciar “zero vestígios na RAM”. O protocolo detalhado e seu custo de memória estão no documento 03.

## 4. Princípios obrigatórios

1. Dados extraídos não são dados aprovados. Aprovação e gravação são ações distintas.
2. Todo valor financeiro possui origem, unidade, moeda, data e significado.
3. Dinheiro novo não é rentabilidade; transferência interna não é receita.
4. Pagamento de fatura não repete as despesas das compras.
5. Ausência de dados não equivale a saldo ou rendimento zero.
6. Simulações e previsões não alteram registros realizados.
7. Sem cotações externas automáticas: valores e índices entram por arquivo ou registro manual.
8. O software funciona sem Ollama, utilizando revisão manual e parsers suportados.
9. Alterações não salvas podem ser perdidas; não existe salvamento silencioso com chave retida.
10. Nenhuma família pode aparecer em consultas, sugestões ou relatórios de outra.

## 5. Escopo de produto

Inclui cofres, integrantes, contas conjuntas, cartões adicionais, categorias, rateio, importação em lote, conciliação, lançamentos manuais, recorrências, parcelas, fechamento mensal, gráficos, carteira de investimentos, avaliações manuais, impostos efetivos e simulados, backup, restauração e exportação deliberada.

Não inclui acesso a internet banking, Open Finance, sincronização cloud, edição simultânea do mesmo cofre, negociação de ativos, execução de pagamentos, declaração fiscal oficial, motor tributário completo, aconselhamento de investimentos ou processamento automático irrestrito de qualquer PDF.

Arquivos escaneados serão identificados como não suportados na primeira versão. OCR local é expansão planejada. Derivativos, venda a descoberto e operações alavancadas exigem extensão específica do modelo e ficam fora da primeira entrega funcional.

## 6. Mapa dos documentos

| Documento | Conteúdo e autoridade |
|---|---|
| [01_REQUISITOS_PRODUTO.md](01_REQUISITOS_PRODUTO.md) | Escopo funcional e requisitos verificáveis |
| [02_ARQUITETURA_STACK.md](02_ARQUITETURA_STACK.md) | Componentes, fronteiras, empacotamento e contratos |
| [03_SEGURANCA_COFRE_BACKUP.md](03_SEGURANCA_COFRE_BACKUP.md) | Senhas, sessão, gravação, recuperação e ameaças |
| [04_MODELO_DADOS_CONTABILIDADE.md](04_MODELO_DADOS_CONTABILIDADE.md) | Entidades, integridade e regime contábil |
| [05_IMPORTACAO_CONCILIACAO.md](05_IMPORTACAO_CONCILIACAO.md) | Parsers, revisão, cobertura e duplicatas |
| [06_INVESTIMENTOS_CALCULOS.md](06_INVESTIMENTOS_CALCULOS.md) | Avaliações, rentabilidade, resgates, impostos e exemplos |
| [07_INTERFACE_GRAFICOS.md](07_INTERFACE_GRAFICOS.md) | Telas, gráficos e estados de interação |
| [08_TESTES_ACEITACAO.md](08_TESTES_ACEITACAO.md) | Cenários, resultados esperados e gates de entrega |
| [09_ROADMAP_DECISOES_RISCOS.md](09_ROADMAP_DECISOES_RISCOS.md) | Fases, decisões arquiteturais e pendências |
| [10_REFERENCIAS_PESQUISA.md](10_REFERENCIAS_PESQUISA.md) | Fontes primárias, aproveitamento e limitações da pesquisa |

Em caso de conflito, decisões aprovadas neste documento prevalecem. Segurança e regras de cálculo devem ser reconciliadas nos respectivos documentos antes de implementação; um conflito não autoriza escolher silenciosamente a interpretação mais simples.

## 7. Critério global de conclusão

Uma família deve conseguir criar um cofre, importar documentos suportados, conferir e salvar com senha, registrar investimentos e avaliações sucessivas, produzir gráficos sem duplicação contábil e restaurar um backup em outro Windows sem acesso à internet. A disponibilidade dos modelos Ollama é independente do backup; dados financeiros não podem depender de reexecutar um modelo para serem recuperados.

## 8. Como usar este conjunto

Ler primeiro o mestre, os requisitos e a segurança. Resolver os riscos técnicos da primeira fase antes de construir telas em escala. Usar os exemplos numéricos como especificações de teste. A pesquisa identifica candidatos; nenhum parser ou distribuição Windows foi executado nesta etapa. Manter versão, motivo e impacto de cada alteração futura.
