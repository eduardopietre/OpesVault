# Investimentos, avaliações, rentabilidade e impostos

Versão 1.0 • 01/10/2026. Especificação matemática de produto. Alíquotas dos exemplos são fictícias; não representam legislação tributária.

## 1. Dois modos de acompanhamento

**Por valor observado:** o usuário cadastra um investimento e informa seu valor em várias datas, mesmo sem conhecer quantidade e preço unitário. Aportes, resgates e rendimentos distribuídos são eventos separados. É o modo apropriado para iniciar com saldos de extratos.

**Por quantidade e preço:** o usuário registra compras, vendas, quantidade, preço, custos e eventos do ativo. Avaliações podem ser derivadas de quantidade × preço ou lançadas como total observado, com comparação de consistência.

Ambos alimentam gráficos. Converter de acompanhamento por valor para quantidade exige reconciliação de posição e custo, sem inventar negociações históricas.

## 2. Avaliação manual em uma data

Campos obrigatórios: posição, data, moeda, valor e natureza do valor. Natureza: bruto antes de imposto de saída; líquido informado; líquido estimado; ou não especificado. Campos opcionais: horário, quantidade, preço unitário, documento, observação e componentes de taxas/imposto.

O usuário pode adicionar quantos pontos forem necessários. Nova data acrescenta observação; correção de data existente cria revisão. Se duas fontes discordarem na mesma data, ambas são preservadas e o usuário seleciona a observação usada no relatório. Nunca fazer média silenciosa.

Valor zero é permitido e distinto de ausência. Avaliação não atualiza custo fiscal nem quantidade por si só. Pontos líquidos não devem ser misturados com pontos brutos em uma única série sem identificação e método explícito. Sem decomposição suficiente, não calcular lucro bruto a partir de saldo líquido.

## 3. Vocabulário

| Termo | Significado |
|---|---|
| Aporte | Fluxo de entrada de capital no perímetro analisado |
| Retirada/resgate | Fluxo de saída do perímetro; discriminar bruto e líquido |
| Distribuição | Provento pago fora do investimento; não contar se já estiver incluído no saldo considerado |
| Valor observado | Avaliação de posição em data determinada |
| Custo remanescente | Capital/custo atribuído às unidades ainda detidas |
| Resultado realizado | Ganho/perda reconhecido em venda ou resgate |
| Resultado não realizado | Diferença entre valor observado e custo da posição remanescente |
| Retorno percentual | Resultado relativo calculado por método identificado |
| Saldo líquido estimado | Valor potencial de saída, conforme premissas, diferente de caixa recebido |

O perímetro é obrigatório: um ativo, uma carteira ou patrimônio familiar. Dividendos que ficam em caixa dentro da carteira são fluxo interno da carteira; não devem entrar simultaneamente em seu valor final e como distribuição externa.

## 4. Resultado monetário do período

Para período com valores inicial e final comparáveis:

**Resultado antes dos impostos/taxas de saída destacados = valor final − valor inicial − aportes + retiradas brutas + distribuições externas brutas.**

Valores de início/fim devem ter a mesma natureza e os fluxos cobrir exatamente o mesmo período. Para pontos de fechamento diário, incluir eventos posteriores ao ponto inicial e até o ponto final. Não descontar uma distribuição da posição e depois somá-la duas vezes.

Se taxas de administração já reduziram as cotas, o cálculo não recupera rendimento anterior a essas taxas. “Bruto” deve dizer de quais deduções está isento. Padrão de rótulo: “Resultado antes de imposto e taxas de saída informados”.

Resultado líquido realizado desconta somente encargos efetivos atribuídos ao evento e ainda não incorporados no valor utilizado. Resultado líquido total com posição aberta exige avaliação líquida comparável ou estimativa expressa do imposto de saída; não apresentar lucro bruto não realizado como líquido definitivo.

## 5. Retorno percentual

Sem fluxos intermediários e com valor inicial positivo: retorno simples = valor final / valor inicial − 1. Se houver distribuições externas, elas podem compor retorno total, explicitando a hipótese de ausência de reinvestimento.

Com aportes e retiradas, não usar variação percentual do saldo como rentabilidade. Oferecer métodos condicionados à disponibilidade dos dados:

- **TWR:** compor os retornos dos subperíodos delimitados pelos fluxos. Exige avaliações adequadas junto aos fluxos ou série diária com convenção consistente. Não interpolar pontos esparsos e chamar o resultado de TWR exato.
- **XIRR:** taxa anualizada que zera a soma dos fluxos descontados por suas datas, incluindo valor inicial negativo e valor final positivo. Convenção proposta: dias corridos/365; aportes negativos e retiradas/distribuições externas positivas. Tratar ausência de solução, múltiplas raízes e instabilidade como indisponibilidade/aviso, sem escolher taxa arbitrária.
- **Modified Dietz:** estimativa quando há avaliações de início/fim e datas dos fluxos. Com Cᵢ positivo para aporte e negativo para retirada, r = (Vf − Vi − soma Cᵢ) / (Vi + soma wᵢCᵢ), sendo wᵢ a fração do período restante após o fluxo. Denominador zero ou inadequado impede cálculo. Rotular como estimativa.

Não anualizar silenciosamente períodos curtos. Retorno absoluto, retorno do período e taxa anualizada têm rótulos diferentes. Benchmark depende de série local importada, mesma moeda, período e método compatível; ausência da série não permite comparação.

No TWR por avaliações adjacentes ao fluxo: para cada subperíodo sem fluxo externo, rⱼ = valor imediatamente antes do próximo fluxo / valor imediatamente depois do fluxo anterior − 1; retorno composto = produto de (1 + rⱼ) − 1. Distribuições externas delimitam subperíodos como retiradas. No XIRR, resolver soma de Fᵢ / (1 + r) elevado a ((dataᵢ − data inicial)/365) = 0, no domínio r > −1. Documentar tolerância, precisão e detecção de raízes na implementação; a ausência de solução não deve retornar zero. No Dietz, usar dias corridos e explicitar fluxo no fechamento do dia; período de duração zero não admite essa estimativa.

## 6. Resgate, custo, imposto e taxas

Campos: data, posição, quantidade ou valor bruto, critério de custo, custo atribuído, ganho/perda, imposto retido, imposto devido informado, taxas, líquido recebido e conta de destino. Distinguir imposto retido no ato de obrigação a pagar posteriormente.

**Líquido creditado no ato = resgate bruto − imposto retido no ato − taxas descontadas no ato.**

Imposto a pagar depois reduz resultado líquido econômico, mas só reduz caixa bancário quando pago. Conciliar esses momentos com partidas próprias. Se apenas líquido e bruto forem conhecidos, diferença é “deduções a discriminar”, não imposto confirmado.

Custo e método variam por classe. Para posições simples homogêneas, custo médio proporcional é opção de gestão; não apresentá-lo como regra fiscal universal. Títulos por lote e prazo exigem controle por aquisição. Posição sem custo confiável permite registrar caixa, mas não apurar ganho tributável exato.

## 7. Motor tributário proposto

Primeira versão admite valores de imposto informados pelo usuário/documento e simulador parametrizado. Modelos: valor fixo informado; percentual sobre ganho positivo; percentual sobre base explicitamente informada. Estrutura suporta regras por prazo, mas tabela legal completa exige módulo futuro por classe.

Cada regra registra nome, versão, vigência, base, alíquota, arredondamento, fonte e natureza de simulação. Não embutir uma alíquota genérica para todas as aplicações. Não presumir que isenções, compensação de perdas, retenções antecipadas, tributos periódicos ou taxas estejam resolvidos.

Eventos de imposto que reduzem cotas ou saldo antes do resgate podem ser registrados manualmente e não devem ser descontados novamente. Simulação nunca substitui imposto efetivo importado. Nenhuma atualização fiscal é buscada automaticamente.

## 8. Exemplos normativos de cálculo

### A. Avaliações sucessivas sem movimentação

Capital e custo inicial: R$ 10.000 em 01/01. Avaliações brutas: R$ 10.100 em 31/01; R$ 10.250 em 28/02; R$ 10.400 em 31/03. Sem fluxos: ganho acumulado R$ 400; retorno simples 4%. O gráfico tem quatro pontos observados. Não afirmar valores nos dias intermediários.

### B. Aporte que não é rendimento

Valor inicial R$ 10.000; aporte durante o período R$ 5.000; valor final R$ 15.300. Resultado monetário R$ 300, não R$ 5.300. Sem data do aporte, não calcular XIRR/Dietz; sem avaliações nos fluxos, não calcular TWR exato. Aumento de saldo é 53%, mas não é rentabilidade.

### C. Resgate total com imposto simulado

Custo R$ 10.000; valor bruto de saída R$ 12.000. Regra fictícia: 15% sobre ganho positivo. Ganho R$ 2.000; imposto R$ 300; taxa de saída R$ 20; líquido R$ 11.680; ganho líquido R$ 1.680. Sem fluxos adicionais, retorno bruto 20% e líquido 16,8%. Taxa anualizada exige datas.

### D. Resgate parcial proporcional

Mesma posição, resgate bruto de R$ 3.000, equivalente a 25% de R$ 12.000. Sob hipótese explícita de posição homogênea: custo atribuído R$ 2.500; ganho R$ 500. Regra fictícia de 15%: imposto R$ 75; taxa R$ 10; líquido R$ 2.915. Posição restante R$ 9.000 e custo restante R$ 7.500, antes de novas variações. Não tributar o ganho total de R$ 2.000 nesse resgate parcial.

### E. Distribuição externa

Valor inicial R$ 10.000; distribuição externa bruta R$ 200; valor final R$ 10.100, sem aporte. Resultado total R$ 300. Se os R$ 200 estiverem incluídos no valor final de uma carteira que também inclui caixa, não somá-los novamente como saída externa.

### F. Informação insuficiente

Primeiro valor conhecido R$ 50.000 em 01/06, sem histórico de aportes e custo. Registrar avaliação inicial de referência. É possível acompanhar variações após essa data; lucro desde a aquisição e imposto sobre ganho permanecem desconhecidos.

## 9. Precisão e rastreabilidade

Arredondar moeda somente nos pontos previstos pelo tipo de evento; exemplo padrão de gestão: centavos com empate para longe de zero, deixando regra fiscal/documental prevalecer quando conhecida. Guardar precisão intermediária de quantidades e taxas. Diferenças residuais são ajustes explícitos, nunca distribuídas silenciosamente.

Todo resultado guarda método, período, perímetro, moeda, dados utilizados e versão do cálculo. Gráficos identificam dados observados, pontos corrigidos, valores estimados e ausência de informação.

## 10. Referências de métodos

Portfolio Performance — TWR: https://help.portfolio-performance.info/en/concepts/performance/time-weighted/

Portfolio Performance — retorno ponderado por dinheiro: https://help.portfolio-performance.info/en/concepts/performance/money-weighted/

Os exemplos, convenções de produto e tratamento de dados faltantes acima são especificações deste projeto. Nenhuma regra tributária legal foi pesquisada ou validada neste conjunto.
