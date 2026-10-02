# Testes, critérios de aceitação e qualidade

Versão 1.0 • 01/10/2026. Plano para implementação futura; nenhum teste de aplicativo foi executado nesta entrega documental.

## 1. Estratégia

Priorizar invariantes financeiros, corrupção/perda de dados, confidencialidade em disco e erros de extração. Testes de unidade validam cálculos e normalização; testes de integração validam cofre e processos; fixtures documentais validam parsers; testes de interface validam jornadas. Não medir qualidade de parsing apenas pelo total financeiro: conferir também datas, descrições, sinais, parcelas e titulares.

## 2. Matriz de aceitação

| ID | Requisitos | Cenário | Resultado esperado |
|---|---|---|---|
| TA-01 | RF-01/02 | Criar, fechar e reabrir | Senha solicitada; dados e PDFs preservados |
| TA-02 | RF-02 | Salvar com senha incorreta | Arquivo anterior inalterado; alterações em RAM preservadas |
| TA-03 | RF-02 | Cancelar senha | Nenhum commit ou arquivo claro produzido |
| TA-04 | RNF-03 | Inspecionar ciclo dos processos | Processo de cofre e conexões encerrados após operação; sem cache deliberado de senha/chave |
| TA-05 | RNF-02 | Examinar temporários e logs | Nenhum conteúdo financeiro em texto claro criado pelo app |
| TA-06 | RF-19 | Interromper salvamento em vários pontos | Recuperar versão anterior ou nova válida, sem mistura |
| TA-07 | RF-19 | Restaurar em outro Windows offline | Mesmos dados, PDFs e histórico; senha exigida |
| TA-08 | RNF-09 | Abrir mesmo arquivo em duas instâncias | Segunda instância não consegue editar concorrente |
| TA-09 | RNF-09 | Substituir arquivo externamente | Salvar detecta divergência da revisão-base e não sobrescreve |
| TA-10 | RF-05/06 | PDF suportado com várias páginas | Campos e linhas correspondem ao esperado humano |
| TA-11 | RF-05/06 | PDF sem texto ou layout novo | Estado pendente/incompatível, sem extração falsamente completa |
| TA-12 | RF-09 | Reimportar mesmo arquivo | Não duplicar operações aprovadas |
| TA-13 | RF-09 | Extratos sobrepostos | Vincular evidências das mesmas operações |
| TA-14 | RF-09 | Duas compras iguais legítimas | Manter ambas após decisão; sem descarte automático |
| TA-15 | RF-08/12 | Compra R$ 100 e pagamento de fatura R$ 100 | Despesa R$ 100; obrigação quitada; caixa −R$ 100 |
| TA-16 | RF-10/12 | Transferência própria R$ 500 | Patrimônio/receita consolidados não aumentam |
| TA-17 | RF-11 | Salário previsto chega no extrato | Realizado vinculado; previsão não soma novamente |
| TA-18 | RF-03/12 | Conta conjunta em duas visões | Consolidado inclui conta apenas uma vez |
| TA-19 | RF-13/22 | Alterar mês fechado | Reabertura com motivo e histórico antes da alteração |
| TA-20 | RF-15/18 | Exemplo A de investimentos | Série correta; resultado R$ 400; retorno 4% |
| TA-21 | RF-14/18 | Exemplo B com aporte | Resultado R$ 300; nunca chamar 53% de rentabilidade |
| TA-22 | RF-16/17 | Exemplo C | Imposto R$ 300; líquido R$ 11.680; simulação não lança caixa |
| TA-23 | RF-16 | Exemplo D parcial | Imposto R$ 75; líquido R$ 2.915; custo restante R$ 7.500 |
| TA-24 | RF-14/18 | Exemplo E e mudança de perímetro | Distribuição contabilizada uma única vez |
| TA-25 | RF-15/18 | Exemplo F sem custo histórico | Gráfico permitido; ganho total/imposto exato indisponíveis |
| TA-26 | RF-15 | Duas avaliações discordantes na mesma data | Fontes preservadas; uma selecionada, sem média automática |
| TA-27 | RF-18 | Falta de avaliação intermediária | Não inventar TWR exato ou pontos diários |
| TA-28 | RF-16 | Imposto devido pago em outra data | Caixa reduz só na data do pagamento; custo reconhecido sem duplicação |
| TA-29 | RF-21 | Ollama desligado ou falhando | Domínio, revisão manual e salvamento funcionam |
| TA-30 | RNF-01 | Tráfego externo bloqueado | Todas as funções locais operam; nenhum recurso visual falta |
| TA-31 | RF-01 | Trocar de família | Nenhum documento, sugestão ou valor da anterior aparece |
| TA-32 | RNF-04 | Centavos, preços fracionários e rateios | Soma exata; política de arredondamento rastreável |
| TA-33 | RNF-07 | Migração e aplicativo antigo | Backup prévio; antigo recusa formato incompatível |
| TA-34 | RF-20 | Exportar relatório claro | Ação explícita; cofre original permanece protegido |
| TA-35 | RF-07 | Aprovar sem salvar e reiniciar | Última revisão salva preservada; perda não é mascarada |
| TA-36 | RF-18 | Ativo sem preço e moeda sem câmbio | Total parcial/indisponível, nunca zero ou soma inválida |

## 3. Ensaios de segurança

Verificar arquivo principal, candidato de gravação, backups, arquivos auxiliares, extrações e logs. Tentar abrir cópia com SQLite comum não deve revelar conteúdo. Validar senha por leitura real, não apenas por abrir handle. Testar corrupção proposital de cópia e tratamento sem destruição.

Avaliação de RAM confirma ausência de retenção deliberada e encerramento de processos, não prova ausência absoluta de resíduos. Documento de teste deve relatar explicitamente essa limitação. Não usar uma busca superficial por senha em memória como certificação criptográfica.

## 4. Ensaios de falha

Falta de espaço; arquivo somente leitura; pendrive removido; antivírus bloqueando substituição; processo encerrado durante importação e durante commit; arquivo adulterado após abertura; backup com senha antiga; perda do modelo local; PDF inválido/enorme; extrapolação do limite de memória. Cada cenário precisa de mensagem e estado recuperável definidos.

## 5. Dados de teste

Conjunto sintético versionado e conjunto privado autorizado por layout. Fixtures incluem valores esperados revisados, com versionamento de mudanças. Parser novo não é liberado só porque processou um arquivo. Separar desenvolvimento e avaliação para evitar ajustar regex apenas ao documento de teste.

## 6. Performance e interface

Medir abertura, gravação, pico de RAM, importação em lote, filtragem e renderização no Windows definido como referência. Registrar volume e tamanho dos PDFs. Durante processamento, interface deve continuar respondendo a navegação permitida/cancelamento. A cifra não pode ser desativada para atingir meta de tempo.

## 7. Gates de liberação

Não liberar versão com falha conhecida de perda de dados, gravação clara, duplicação financeira, custo/rentabilidade incorretos nos exemplos normativos ou ausência de restauração validada. Cobertura por banco é publicada com limitações; falha de layout não bloqueia uso manual, mas bloqueia declarar aquele layout suportado.
