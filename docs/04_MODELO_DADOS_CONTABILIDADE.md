# Modelo conceitual de dados e contabilidade

Versão 1.0 • 01/10/2026. Modelo de domínio, sem esquema SQL.

## 1. Estrutura do cofre

Um cofre tem identificador, versão de formato, revisão e moeda de apresentação. A primeira entrega calcula em BRL; moeda de origem é preservada, mas agregações de outras moedas exigem câmbio informado e ficam indisponíveis sem ele. Várias famílias significam vários cofres, não uma tabela compartilhada entre famílias.

| Entidade | Campos e vínculos essenciais |
|---|---|
| Integrante | Identificador, nome, papel (titular ou dependente), situação, participação nas contas. O papel só identifica a pessoa; não concede nem bloqueia nada. Esquema 2: cofres do esquema 1 são migrados ao abrir, com todos os integrantes como titulares |
| Conta | Instituição, tipo, moeda, titulares, identificação mascarada |
| Cartão | Conta de liquidação preferida, final, titular, adicionais |
| Fatura | Cartão, ciclo, fechamento, vencimento, total, pagamentos e status |
| Documento | Hash, bytes originais, nome, instituição, período, importação |
| Importação | Data, parser, versão, estado, documentos e avisos |
| Evidência | Documento, página, região, texto e campo de destino |
| Item extraído | Valor original, normalização, status e correções |
| Operação | Tipo, datas, moeda, descrição, origem e versão |
| Partida | Operação, conta contábil, débito/crédito e valor exato |
| Categoria/rateio | Hierarquia, participação e soma controlada |
| Recorrência | Regra, vigência, calendário, tolerâncias e exceções |
| Parcela | Compra-mãe, número, total, vencimento e fatura |
| Conciliação | Itens relacionados, método, diferença e decisão |
| Fechamento | Ano/mês, regime, revisão, pendências e reaberturas |
| Ativo | Identificação, classe, moeda e unidade |
| Posição | Ativo, conta de custódia, titular e modo de controle |
| Movimento de investimento | Compra, venda, aporte, resgate, provento ou evento |
| Avaliação | Posição, data, valor bruto/líquido, fonte e qualidade |
| Custo/lote | Origem do custo, quantidade, valor e método |
| Imposto/taxa | Evento, natureza, base, valor, data e estado real/simulado |
| Regra tributária | Nome, versão, vigência, fonte e parâmetros manuais |
| Histórico | Entidade, versões, operador declarado, motivo e instante |
| Financiamento | Contrato (saldo devedor, taxa mensal, prazo, SAC ou Price, primeiro vencimento, seguros por parcela), conta de dívida, conta de pagamento e categorias de juros e encargos. O cronograma é calculado, nunca guardado |
| Pagamento de parcela / amortização antecipada | Financiamento, número da parcela (ou "depois da parcela n"), operação, data e efeito (reduzir prazo ou parcela) |
| Marcadores | Operação e lista de marcadores ("Viagem 2026"). Classificação, não fato financeiro: fica ao lado da operação e pode mudar em mês fechado |
| Reembolso | Despesa original, quem reembolsa, valor esperado, recebimentos (estornos) e negativa |
| Acerto entre integrantes | Quem pagou, para quem, valor e data; não movimenta dinheiro |
| Conferência de saldo | Conta, data e saldo informado pelo banco; a diferença é calculada na hora |
| Categoria dedutível | Categoria de despesa e tipo de dedução (saúde, educação, PGBL, pensão, doações, outras) |
| Comprovante | Operação e documento do cofre (PDF ou imagem) |
| Filtro salvo | Nome e filtros do Livro (período nomeado, conta, integrante, texto, situação, origem, marcador) |
| Estabelecimento | Chave (descrição limpa e normalizada) e nome aprovado |
| Suspeita conferida | Operação e tipo (duplicidade, valor fora do comum) marcados como "está certo" |
| Meta | Nome, patrimônio líquido ou contas escolhidas, valor-alvo, prazo opcional, criação e arquivamento |

Os tipos da revisão de 03/10/2026 são novos tipos persistidos, sem mudar os existentes: o esquema do domínio continua 2, e versões anteriores do aplicativo recusam o cofre com a mensagem de versão mais nova.

### 1.1 Regras das funcionalidades de 03/10/2026

- **Parcela de financiamento**: uma operação com a amortização a débito da dívida, os juros e os seguros a débito das categorias e o total a crédito da conta de pagamento. Pagar mais que a parcela (multa, juros de atraso) soma a diferença aos juros; pagar menos não é registrado como parcela. Juros de cada parcela = saldo × taxa, arredondado em centavos com empate para longe de zero; a última parcela leva o resíduo.
- **Amortização antecipada**: o valor inteiro abate a dívida, sem juros, depois da última parcela paga. Reduzir o prazo mantém a parcela (Price) ou a amortização (SAC); reduzir a parcela recalcula com as parcelas restantes.
- **Reembolso recebido**: estorno (`REFUND`) das categorias da despesa original, em proporção, no mês do recebimento. Nunca é receita.
- **Quem pagou** (acertos): o único titular da conta de onde saiu o dinheiro, ou o titular do cartão. Conta conjunta pagou por todos e não cria dívida entre integrantes. A parte de cada um vem do rateio da partida ou, sem rateio, do integrante da operação.
- **Dedutíveis**: por ano de pagamento (ou da compra no cartão), por pessoa, líquidos de estornos e reembolsos. Material de apoio, sem limites legais.

## 2. Invariantes

Débitos e créditos de uma operação devem se equilibrar na moeda correspondente. Valores monetários não usam float como fonte autoritativa. Não aceitar posição negativa quando a classe não permite venda a descoberto. Referências nunca apontam para documentos ou operações inexistentes.

Uma operação aprovada pode ter várias evidências de documentos distintos. Não criar nova operação só porque apareceu novamente no extrato de outra conta. Remover documento não deve apagar registro financeiro silenciosamente; o usuário decide arquivar ou desfazer a importação mediante revisão dos vínculos.

Origem manual e origem extraída são igualmente registradas. Modificações não sobrescrevem a versão anterior sem histórico. Exclusões financeiras após fechamento devem usar cancelamento/estorno com motivo, mantendo rastreabilidade.

## 3. Registros, previsões e avaliações

Três famílias de dados não se confundem:

- Realizados: operações financeiras reconhecidas e aprovadas.
- Previsões: salários futuros, parcelas, assinaturas e simulações.
- Avaliações: valor observado de um ativo em uma data; não são fluxo de caixa.

Previsão realizada é vinculada à operação efetiva e deixa de ser somada como pendência. Avaliação não altera quantidade ou custo por si só. Uma série de avaliações não cria aportes implícitos.

## 4. Contabilidade simplificada na interface

O usuário vê receitas, despesas, contas e investimentos; o domínio mantém ativos, passivos, patrimônio, receitas e despesas. Datas de caixa e competência produzem consultas diferentes do mesmo conjunto de fatos.

| Exemplo | Débito conceitual | Crédito conceitual |
|---|---|---|
| Salário recebido | Banco | Receita de salário |
| Compra no cartão | Despesa ou ativo adquirido | Obrigação do cartão |
| Pagamento de fatura | Obrigação do cartão | Banco |
| Transferência própria | Banco de destino | Banco de origem |
| Compra de investimento | Investimento ao custo | Banco |
| Provento recebido | Banco | Receita de investimento |
| Saldo de abertura | Ativo correspondente | Patrimônio de abertura |

Avaliações patrimoniais são mantidas em camada separada do custo. Relatórios apresentam custo e valor observado, sem converter os dois em receita simultaneamente. Se houver futura contabilização formal a valor justo, ela exige decisão própria e testes contra dupla contagem.

## 5. Datas, competência e parcelas

Guardar ocorrência, lançamento bancário, competência, vencimento e liquidação quando existirem. Fonte que não informa determinada data deixa lacuna, não preenche automaticamente com a data de importação.

Compra parcelada gera obrigação e calendário financeiro. A competência depende do bem/serviço: consumo imediato pode pertencer à compra; serviço anual pode ser apropriado ao longo da vigência; aquisição de ativo não é automaticamente despesa integral. A interface sugere tratamento simples, documenta a escolha e permite ajustar. Calendário de parcelas nunca é sinônimo implícito de competência.

Estornos preservam ligação com a compra. Pagamento parcial da fatura reduz obrigação; juros, multa e IOF são componentes próprios. Não tratar limite do cartão como patrimônio.

**Atribuição de pagamentos às faturas** (decisão de 02/10/2026): um pagamento feito no dia *d* quita primeiro as faturas já vencidas antes de *d* que ainda têm saldo, da mais antiga para a mais nova; só a sobra vai para a fatura cujo período contém *d* (o primeiro vencimento em *d* ou depois). Pagamento em dia ou antecipado fica na própria fatura; o que passar do devido fica como crédito nela. A regra vale para toda a vida do cartão, então uma fatura antiga em aberto é quitada antes de qualquer outra.

## 6. Contas conjuntas e consolidação

Conta conjunta pertence a vários integrantes, mas entra uma vez no consolidado da família. Visão por integrante pode usar rateio configurado; somar visões individuais sem rateio não deve duplicar total. Transferência entre integrantes do mesmo cofre é interna no consolidado, embora apareça nos fluxos individuais.

O perímetro do relatório define se um fluxo é interno ou externo. Transferir da conta bancária para corretora da família não muda patrimônio consolidado; representa aporte no perímetro da carteira de investimentos.

## 7. Fechamento e versionamento

Fechamento guarda revisão e resumo por período, sem criar arquivo mensal separado. Bloquear alterações em período fechado até reabertura com motivo. Importar documento atrasado exige escolher revisar/reabrir; não redistribuir valores para o mês atual silenciosamente.

Migração de formato exige backup verificado, execução transacional e checagem de invariantes. Aplicativo antigo deve recusar formato novo com mensagem clara. Exportação de intercâmbio documenta identificadores, escalas, datas, valores e versão; o formato exato será especificado quando o recurso for implementado.
