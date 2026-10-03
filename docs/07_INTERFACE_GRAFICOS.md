# Interface, navegação e gráficos

Versão 1.0 • 01/10/2026. Especificação de experiência, sem mockup executável.

## 1. Estrutura de navegação

Janela principal com navegação lateral: Visão geral; Orçamento; Calendário; Livro financeiro; Importar e revisar; Contas e cartões; Recorrências; Investimentos; Relatórios; Metas; Reembolsos e acertos; Documentos; Configurações. Arquivos soltos em qualquer tela vão para a importação. Nome do cofre, período, regime e estado de salvamento sempre visíveis.

Tela inicial apresenta criar/abrir/restaurar. Lista de recentes é opcional e guarda apenas caminhos consentidos; não exibe saldos com cofre fechado. Nome da família pode ficar oculto até desbloqueio.

## 2. Telas principais

| Tela | Conteúdo | Ações |
|---|---|---|
| Visão geral | Caixa, entradas, saídas, compromissos e patrimônio | Alterar período/regime e abrir detalhe |
| Livro financeiro | Tabela por data, conta, integrante, categoria e origem | Incluir, editar, ratear, conciliar e filtrar |
| Importação | Fila de arquivos, instituição, estado e pendências | Selecionar arquivos, cancelar trabalho e revisar |
| Conferência | PDF à esquerda, campos e tabela à direita | Selecionar evidência, corrigir, aprovar ou rejeitar |
| Conta/cartão | Saldo, movimentos, ciclo e obrigações | Vincular pagamento, conferir fatura e adicionais |
| Recorrências | Regras, previsões e exceções | Confirmar padrão, pausar, editar e vincular realizado |
| Investimento | Posição, custo, avaliações, movimentos e gráfico | Nova avaliação, aporte, distribuição, resgate e simulação |
| Backup | Revisão salva, cópias e integridade | Criar cópia e restaurar em destino separado |
| Calendário | Faturas, recorrências e parcelas de financiamento do mês, por dia, com situação | Abrir o ponto onde se paga ou vincula |
| Reembolsos e acertos | Reembolsos a receber; quem deve a quem na família e as despesas que formam o saldo | Registrar recebimento, negativa e acerto |
| Metas | Metas, progresso, quanto falta por mês, ritmo recente; gráfico e tabela da meta | Criar, editar, arquivar |
| Financiamentos (Contas e cartões) | Contrato, cronograma, saldo devedor, juros a pagar | Pagar parcela, simular e registrar amortização antecipada |

## 3. Adicionar avaliação

Formulário curto: investimento; data; valor; moeda; natureza bruta/líquida/não especificada; fonte; observação. Campo opcional de quantidade e preço só aparece no modo por quantidade. Ao salvar na sessão, o gráfico atualiza imediatamente e a janela permanece marcada como não salva em arquivo.

Se já existir avaliação naquela data, apresentar “corrigir observação” ou “registrar outra fonte”; preservar histórico. Se houver movimentos no mesmo dia, pedir posição temporal quando ela altera interpretação, como antes/depois do aporte. Default documentado: fechamento do dia após movimentos registrados.

## 4. Gráficos obrigatórios

| Gráfico | Séries/eixos | Cuidados |
|---|---|---|
| Entradas e saídas mensais | Barras em BRL, meses no eixo horizontal | Regime e contas sempre indicados |
| Resultado mensal | Receitas menos despesas por competência | Não confundir com variação do saldo bancário |
| Fluxo de caixa | Entradas, saídas e saldo por data | Transferências internas excluídas do consolidado |
| Despesas por categoria | Barras ordenadas com valores | Estornos e categoria indefinida visíveis |
| Patrimônio | Ativos, passivos e patrimônio líquido | Avaliações antigas e ativos ausentes sinalizados |
| Evolução de investimento | Valores observados por data, marcadores de aportes/resgates | Valor bruto e líquido em séries distintas |
| Resultado do investimento | Ganho/perda monetário acumulado | Capital aportado não vira rendimento |
| Rentabilidade | Percentual com método indicado | TWR/XIRR/Dietz só quando calculáveis |
| Composição da carteira | Valor por ativo/classe | Data-base, cobertura de preços e caixa indicados |
| Projeção de compromissos | Parcelas e recorrências futuras | Aparência de previsão, separada do realizado |
| Saldo projetado | Saldo de cada conta líquida dia a dia, a partir de hoje | Previsão com o que já está registrado; atrasados contam hoje |
| Comparação com a média | Mês, média dos meses anteriores e mesmo mês do ano anterior, por categoria | Meses antes dos registros não entram na média |
| Marcadores | Despesa total por marcador, ou por categoria dentro de um marcador | Soma em qualquer mês |
| Despesas dedutíveis | Por categoria marcada e por pessoa, no ano | Material de apoio, sem limites legais |
| Despesas por estabelecimento | Maiores estabelecimentos no período e "Outros" | Nome aprovado ou descrição limpa, indicado no ponto |
| Fechamento do ano | Bens e dívidas em 31/12, com o ano anterior na tabela | Material de apoio; PDF anual com receitas, proventos, imposto retido, ganhos e dedutíveis |
| Mês a mês (Visão geral), saldo da conta, faturas, orçamento, financiamento | Séries mensais ou por parcela | Sempre com a tabela dos mesmos valores abaixo |

Todo gráfico com valores ao longo do tempo tem, na mesma tela e logo abaixo, a tabela com os mesmos números, gerada do mesmo conjunto de dados (`charts.data.table_rows`). Gráfico e tabela ficam em seções recolhíveis, nunca em abas separadas (`16` §4, regra 9).

## 5. Interação e leitura

Gráficos aceitam período, contas, integrantes, categorias e ativos. Clique em ponto ou barra abre dados subjacentes. Tooltip mostra data, valor, moeda, origem, natureza, método e qualidade. Permitir zoom, redefinir escala e exportar imagem por ação explícita.

Pontos observados ficam marcados. Linhas que conectam observações são recurso visual, não preços diários inferidos. Lacunas relevantes e observações antigas são identificadas. Ausência de dado não gera zero. Não misturar BRL e porcentagem em eixo único; evitar eixos duplos por padrão.

Para composição patrimonial em uma data, regra proposta: último valor conhecido até a data, com idade da observação e cobertura do total. Não usar preço futuro para preencher passado. Ativos sem avaliação aparecem em lista separada e tornam o total “parcial”.

## 6. Simulador de resgate

Mostrar valor bruto, custo atribuído, ganho, base de imposto, alíquota/regra, imposto, taxas e líquido. Todo campo estimado é identificado. Resultado da simulação não altera carteira, caixa ou histórico realizado. Comando “Registrar operação” abre revisão preenchida, exigindo confirmação e posterior salvamento com senha.

## 7. Salvar e fechar

Ctrl+S abre solicitação de senha em toda gravação. Mostrar o que será salvo e revisão atual, sem expor senha. Sucesso atualiza estado para “Salvo”; erro mantém alterações e explica ação possível. Não mostrar sucesso antes de commit verificado.

Ao fechar com alterações: Salvar e fechar; Descartar alterações; Cancelar. Sem senha, não há salvamento de emergência oculto. Avisar que trabalho não salvo se perde em travamento; usar mensagem contextual no fluxo, sem alertas repetitivos a cada edição.

## 8. Acessibilidade e linguagem

Usar formatos brasileiros, datas inequívocas, sinal e cor juntos para ganho/perda, contraste adequado e navegação por teclado. Testar Windows com escala 100%, 150% e 200%. Tabelas permitem ordenar sem mudar dados; cabeçalhos persistem em rolagem. Textos de status devem explicar pendência concreta, não termos internos de bibliotecas.
