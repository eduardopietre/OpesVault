# Importação, parsing, revisão e conciliação

Versão 1.1 • 02/10/2026. Inclui exportações estruturadas (CSV/OFX).

## 1. Contrato de cobertura

Suporte é declarado por instituição + produto + tipo de documento + versão de layout, nunca apenas pelo nome do banco. Alvo inicial: faturas Itaú, Bradesco e Nubank; extrato Itaú; Caixa e investimentos entram conforme amostras validadas. Essa ordem é proposta, sem excluir bancos do escopo final.

Exportações estruturadas seguem a mesma regra: um CSV do Nubank e um OFX do Itaú são layouts distintos, cada um com versão e catálogo próprios. Quando o banco oferece CSV ou OFX para o mesmo período, a interface sugere esse formato por ser mais confiável que o PDF; o PDF continua necessário para informações que só ele traz (total e ciclo da fatura, encargos, saldos). Os dois formatos podem fornecer evidências da mesma operação (§6).

Nenhuma biblioteca encontrada comprova cobertura universal. O projeto mantém catálogo com layouts suportados, versões do parser, documentos de teste, campos extraídos e limitações conhecidas. Layout desconhecido produz pendência, não aceitação silenciosa.

## 2. Campos por documento

| Documento | Campos prioritários | Validação |
|---|---|---|
| Extrato de conta | Instituição, conta, titular, período, saldos, datas, descrições, débitos e créditos | Saldo inicial + entradas − saídas = saldo final, quando comparáveis |
| Fatura | Titular, cartões, ciclo, vencimento, total, compras, parcelas, estornos, juros, IOF, pagamentos e saldo anterior | Reconstrução do total conforme semântica do layout |
| Extrato de investimento | Conta, ativo, período, quantidade, posição, valores, aportes, resgates, taxas e rendimentos | Quantidade e caixa reconciliados; avaliação separada do custo |
| Nota de negociação | Ativos, quantidades, preços, data, custos e liquidação | Soma de operações e custos contra financeiro informado |

Informações acessórias, como avisos e tabelas de encargos, devem ser preservadas no original e classificadas como extraídas ou não mapeadas. “Todas as informações” significa transparência sobre a cobertura; não prometer estruturação semântica de qualquer texto bancário arbitrário.

## 3. Pipeline

1. Validar tipo real, tamanho, número de páginas e acesso. Tratar PDF protegido com senha transitória; não guardar a senha fora do cofre nem registrá-la em log.
2. Calcular hash do arquivo, detectar importação idêntica e preservar os bytes originais.
3. Extrair texto e coordenadas; avaliar se existe texto útil. Documento escaneado segue para revisão manual ou estado de OCR pendente.
4. Identificar candidato a layout. Se houver múltiplos candidatos plausíveis, pedir escolha ou declarar inconclusivo.
5. Executar parser específico e registrar versão. Normalizar datas e números brasileiros com evidência.
6. Validar cada campo e conciliar totais. Relatar linhas ignoradas, sinais ambíguos e seções não mapeadas.
7. Comparar com histórico e previsões. Sugerir relações sem descartar linhas automaticamente.
8. Exibir revisão lado a lado. Usuário corrige, aprova ou rejeita.
9. Incorporar itens aprovados ao registro da sessão. Solicitar senha somente quando o usuário salvar.

PDF originalmente protegido permanece arquivado como recebido. Para visualizar novamente, pode exigir sua senha original; armazená-la cifrada dentro do cofre é opção explícita futura. A senha do cofre não substitui a senha do PDF.

### Exportações estruturadas (CSV e OFX)

Seguem o mesmo pipeline, sem as etapas de texto e coordenadas. Mesmo estruturadas, não são confiáveis por definição:

- **CSV:** identificar codificação (UTF-8, Windows-1252), separador, separador decimal, cabeçalho e sinal. Planilhas exportadas podem trazer valores formatados (`R$ 1.234,56`), linhas de total ou de saldo misturadas às operações e datas sem ano.
- **OFX:** é SGML (versão 1.x) ou XML (2.x), muitas vezes com cabeçalho e codificação inconsistentes. Usar `FITID` como identificador bancário quando presente, sem supor que seja único entre arquivos de períodos diferentes. `LEDGERBAL` e `AVAILBAL` são saldos informados, a conciliar como no extrato em PDF.
- Fórmulas e macros de planilhas nunca são executadas; o conteúdo é lido como dado. Arquivos `.xlsx` ficam fora até decisão própria.
- A evidência de um item estruturado é o arquivo, a linha ou o elemento OFX de origem, em vez de página e região.

## 4. Regras de interpretação

Tratar continuações de descrição, múltiplas colunas, linhas que atravessam páginas, meses abreviados, virada do ano, sinal de débito/crédito, separadores de milhar, estornos e parcelas. Não deduzir ano apenas do relógio do computador. Número de parcela e número total não são valor da compra.

Não usar regex isolada como única validação monetária. Datas impossíveis são erro. Valores negativos e créditos precisam de semântica do produto. Campo ausente permanece desconhecido; não converter para zero.

A evidência contém página e região quando disponíveis; parsers baseados somente em texto mantêm trecho e página sem inventar coordenadas. Correção do usuário registra valor anterior, novo valor e autoria declarada.

## 5. IA local

Ollama pode propor categoria, estabelecimento normalizado e extração alternativa. Recebe somente conteúdo necessário, sem senha do cofre ou acesso ao sistema de arquivos. Instruções contidas em PDFs são dados, não comandos. Não habilitar ferramentas, execução, downloads ou navegação.

Resposta estruturada é validada em tipos e significado. JSON válido não prova exatidão. Registrar modelo, identificação da versão quando disponível, configuração e versão do prompt, além do resultado aprovado. Não exigir regeneração do resultado para abrir o cofre.

Campos sem evidência precisam de revisão; não inventar CPF, conta, taxa, data ou valor. Classificações não autorizam lançamento de dinheiro. A interface distingue sugestão automática de informação documental.

## 6. Duplicatas e conciliação

Hash idêntico detecta mesmo arquivo. Para operações, usar identificador bancário quando disponível, conta, data, valor, descrição, parcela e contexto. Dois pagamentos iguais podem ser legítimos: agrupamento aproximado é sugestão, não chave única absoluta.

Extratos sobrepostos podem fornecer novas evidências da mesma operação. Pagamento da fatura visto no cartão e no banco é ligado a uma liquidação. Transferência própria aparece nos dois extratos; representar as duas partidas de uma operação e preservar ambas as fontes. Não depender apenas de valor e data para identificar transferência.

Matching de recorrência e de registro manual segue o mesmo princípio: vincular, substituir previsão ou manter separado por decisão explicada. Resgates de investimento líquidos devem ser conciliados com imposto e taxas, sem transformar diferença automaticamente em imposto.

## 7. Aprovação e divergências

Erros bloqueantes: campos essenciais inválidos, conta indefinida, desequilíbrio contábil, duplicata não resolvida ou total discrepante sem decisão. Avisos: categoria incerta, descrição incompleta, avaliação antiga e informação acessória não mapeada.

Permitir importação parcial somente por escolha explícita, identificando o documento como parcial e preservando itens pendentes. Uma diferença pode ser aceita como pendência documentada; nunca como ajuste fictício. Fechamento mensal destaca pendências não resolvidas.

## 8. Coleção de testes

Cada layout precisa de casos normais e de borda: várias páginas, cartão adicional, compras repetidas, estorno, parcelas, virada de ano, juros, caracteres especiais e mudança de layout. Exemplos podem ser sintéticos, mas devem ser complementados por documentos autorizados representativos.

Anonimização precisa alterar efetivamente conteúdo e metadados, não só desenhar retângulo sobre texto. Dados reais não entram em repositório público. Manter esperado de referência revisado por humano, com campos e totais. A pesquisa atual não confirmou corpus público suficiente para os bancos-alvo; o levantamento está no documento 12. Fixtures de terceiros só entram com licença compatível, crédito à origem e verificação de que não há dados pessoais no texto, nos metadados nem em imagens.
