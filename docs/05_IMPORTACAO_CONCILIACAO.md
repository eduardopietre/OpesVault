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

Implementação (02/10/2026): AES-256, AES-128 e RC4-128 com senha de usuário pedem a senha na importação; PDF só com senha de proprietário abre sem perguntar. O visualizador pede a senha uma vez por documento exibido ("Informar senha…") e mantém o documento aberto em memória enquanto ele está na tela; escolher outro layout pede a senha de novo. A senha nunca é guardada nem registrada (`tests/test_pdf_password.py`).

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

Implementação (`ai/ollama.py`, `importing/ai_suggestions.py`; revista em 03/10/2026, prompt `p3`):

- só `127.0.0.1`, sem proxy, sem modelos de nuvem; a lista de modelos em Configurações vem do Ollama local e omite os de nuvem;
- envia apenas descrições e nomes de categorias, em lotes de 40, com temperatura 0, saída por esquema JSON e raciocínio ("think") desligado; servidores ou modelos que não aceitam a opção seguem sem ela; cada descrição vai numa linha só, para que o texto de um documento não forje outra linha da lista;
- **exemplos da família:** até 24 itens já aprovados (descrição → categoria), os mais parecidos com os que estão sendo perguntados, vão junto como referência. Repetições exatas não são perguntadas nem viram exemplo: a sugestão pelo histórico já as cobre;
- **descrições repetidas** (assinatura, parcelas, mesma loja com outro número) são perguntadas uma vez e a resposta vale para todos os itens;
- despesas e receitas são perguntadas separadamente, cada uma só com as suas categorias; categorias fora da lista e índices inválidos são descartados;
- **três passos:** `plan_requests` copia o que será enviado (thread visual), `ask` consulta o modelo sem acesso ao livro (segundo plano) e `apply_suggestions` preenche só itens ainda pendentes e sem categoria (thread visual). Por isso a revisão continua liberada durante a consulta, e a escolha feita à mão nesse meio-tempo prevalece;
- uma resposta malformada é pedida de novo uma vez; se falhar outra vez, só aquele lote fica sem sugestão e os demais são mantidos. Ollama desligado ou modelo ausente encerram a consulta na hora, com a instrução de instalação (`ollama pull <modelo>`);
- cada sugestão guarda `ollama:<modelo>:<versão do prompt>@<digest>`, o digest do modelo instalado (sua versão exata); a revisão mostra "sugestão (IA local, <modelo>)";
- com a IA ligada, o modelo é carregado enquanto o arquivo é lido, e depois de importar a consulta começa sozinha para os itens sem categoria; falhas vão para a barra de status, sem diálogo. O botão **Sugerir com IA (N)** repete a consulta para o documento aberto, com progresso e **Cancelar** (ao fim do lote atual);
- o Ollama mantém em memória o último prompt enquanto o modelo está carregado; ao fechar o cofre ou o app, os modelos usados na sessão são descarregados (`keep_alive: 0`);
- `scripts/avaliar_modelos.py` compara modelos instalados na tarefa real (acerto, erros, abstenções, linhas com instrução embutida, estabilidade, tempo e parte do modelo na GPU); `--exemplos` mede também com exemplos de histórico.

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
