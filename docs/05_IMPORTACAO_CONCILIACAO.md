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
8. Sugerir a categoria, nesta ordem de confiança: a escolha feita à mão (nunca sobrescrita) > uma regra do usuário > o que foi **aprendido com o uso** > as regras padrão por palavra-chave > a IA local (§5), só para o que ficou sem categoria. O aprendizado (`importing/learning.py`) lê a categoria que cada lançamento ativo tem hoje, inclusive depois de correções e reclassificações, pela chave do estabelecimento (sem números, parcelas e cartão): as escolhas recentes decidem, as da mesma conta vêm primeiro e uma compra parcelada conta uma vez. Nada novo é gravado no cofre. A revisão diz de onde veio cada sugestão ("aprendida: 3 escolha(s) iguais").
8. Exibir revisão lado a lado. Usuário corrige, aprova ou rejeita.
9. Incorporar itens aprovados ao registro da sessão. Solicitar senha somente quando o usuário salvar.

PDF originalmente protegido permanece arquivado como recebido. Para visualizar novamente, pode exigir sua senha original; armazená-la cifrada dentro do cofre é opção explícita futura. A senha do cofre não substitui a senha do PDF.

Implementação (02/10/2026): AES-256, AES-128 e RC4-128 com senha de usuário pedem a senha na importação; PDF só com senha de proprietário abre sem perguntar. O visualizador pede a senha uma vez por documento exibido ("Informar senha…") e mantém o documento aberto em memória enquanto ele está na tela; escolher outro layout pede a senha de novo. A senha nunca é guardada nem registrada (`tests/test_pdf_password.py`).

### Exportações estruturadas (CSV e OFX)

Seguem o mesmo pipeline, sem as etapas de texto e coordenadas. Mesmo estruturadas, não são confiáveis por definição:

- **CSV:** identificar codificação (UTF-8, Windows-1252), separador, separador decimal, cabeçalho e sinal. Planilhas exportadas podem trazer valores formatados (`R$ 1.234,56`), linhas de total ou de saldo misturadas às operações e datas sem ano.
- **CSV de qualquer banco** (`csv-extrato-generico`, web, 07/10/2026): quando nenhum layout próprio reconhece o arquivo, um extrato de conta é lido pelos nomes das colunas numa linha de cabeçalho, que pode vir depois de linhas sobre a conta ("Conta: 12345-6", "Período: … a …"): data, descrição ou histórico, e valor (com coluna D/C opcional) ou débito e crédito separados; saldo e documento quando houver. O separador decimal é decidido uma vez para o arquivo. Linhas de saldo e total não viram lançamento (o "Saldo anterior" vira saldo inicial da conciliação); cada saldo impresso é conferido com o anterior mais o valor. Data sem ano usa as datas do próprio documento. Confiança 0,7: um layout de banco (0,9) sempre ganha. CSV de cartão continua exigindo layout próprio.
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

Implementação (`ai/ollama.py`, `ai/prompts.py`, `importing/ai_suggestions.py`, `importing/ai_merchants.py`, `ui/local_ai.py`; revista em 04/10/2026, prompts `p4` para categorias e `m1` para nomes):

- só `127.0.0.1`, sem proxy, sem modelos de nuvem; a porta pode mudar (Configurações › IA local, preferência deste computador, para quem usa `OLLAMA_HOST=127.0.0.1:<porta>`), o endereço nunca; a lista de modelos em Configurações vem do Ollama local e omite os de nuvem;
- envia apenas descrições e nomes de categorias, em lotes de 40, com temperatura 0, saída por esquema JSON e raciocínio ("think") desligado; servidores ou modelos que não aceitam a opção seguem sem ela; cada descrição vai numa linha só, para que o texto de um documento não forje outra linha da lista;
- **exemplos da família:** até 24 lançamentos do livro (descrição → categoria que têm hoje), os mais parecidos com os que estão sendo perguntados, vão junto como referência. Vêm do livro, e não dos itens aprovados, para seguir correções, reclassificações e lançamentos manuais. Repetições exatas não são perguntadas nem viram exemplo: a sugestão pelo histórico já as cobre; lançamentos que estão sendo perguntados nunca são exemplo de si mesmos;
- **categorias com o pai:** cada categoria vai como o usuário a vê (“Alimentação › Mercado”), o que diz ao modelo do que se trata e separa subcategorias de mesmo nome;
- **descrições repetidas** (assinatura, parcelas, mesma loja com outro número) são perguntadas uma vez e a resposta vale para todos os itens;
- despesas e receitas são perguntadas separadamente, cada uma só com as suas categorias; categorias fora da lista e índices inválidos são descartados;
- **três passos:** `plan_requests` copia o que será enviado (thread visual), `ask` consulta o modelo sem acesso ao livro (segundo plano) e `apply_suggestions` preenche só itens ainda pendentes e sem categoria (thread visual). Por isso a revisão continua liberada durante a consulta, e a escolha feita à mão nesse meio-tempo prevalece;
- uma resposta malformada é pedida de novo uma vez; se falhar outra vez, só aquele lote fica sem sugestão e os demais são mantidos. Ollama desligado ou modelo ausente encerram a consulta na hora, com a instrução de instalação (`ollama pull <modelo>`);
- cada sugestão guarda `ollama:<modelo>:<versão do prompt>@<digest>`, o digest do modelo instalado (sua versão exata); a revisão mostra "sugestão (IA local, <modelo>)";
- com a IA ligada, o modelo é carregado enquanto o arquivo é lido, e depois de importar a consulta começa sozinha para os itens sem categoria; falhas vão para a barra de status, sem diálogo. O botão **Sugerir com IA (N)** repete a consulta para o documento aberto, com progresso e **Cancelar** (ao fim do lote atual);
- **Livro** (botão **IA local**): para os lançamentos selecionados (dois ou mais) ou todos os exibidos, até 2000, a IA sugere outra categoria (só receitas e despesas de uma categoria; rateios ficam como estão) ou nomes legíveis de estabelecimentos (uma pergunta por estabelecimento, só os sem nome aprovado). A resposta vem numa lista de conferência em que cada mudança pode ser desmarcada e cada nome ajustado; nada muda antes de aplicar. A reclassificação grava no histórico o motivo com a origem (`ollama:<modelo>:p4@<digest>`); o nome aprovado grava a origem no histórico do `merchant_alias`, sem mudar o esquema;
- **nomes validados pelo significado:** um nome só é aceito se tiver até 60 caracteres e ao menos uma palavra de três letras ou mais presente na descrição (sem acento, caixa ou espaço: “PAG*JOSEDASILVA” → “José da Silva” passa; “PADARIA REAL” → “Carrefour” não). Nomes iguais ao atual não são propostos;
- **Novo lançamento:** quando o histórico não conhece a descrição, **Perguntar à IA local** consulta só aquela descrição e seleciona a categoria sugerida, com o aviso “sugerida pela IA local”; a escolha feita à mão enquanto o modelo responde prevalece;
- **GPU ou CPU:** **Verificar Ollama** carrega o modelo escolhido e lê `/api/ps` para dizer quanto dele coube na GPU; na CPU cada consulta leva muitas vezes mais;
- o Ollama mantém em memória o último prompt enquanto o modelo está carregado; ao fechar o cofre ou o app, os modelos usados na sessão são descarregados (`keep_alive: 0`), no endereço em que foram usados;
- `scripts/avaliar_modelos.py` compara modelos instalados na tarefa real (acerto, erros, abstenções, linhas com instrução embutida, estabilidade, tempo e parte do modelo na GPU); `--exemplos` mede também com exemplos de histórico.

**Assistente com ferramentas** (decisão do usuário de 04/10/2026; `opesvault/assistant`, `ui/pages/assistant_page.py`). Revê o “não habilitar ferramentas” acima só para o Assistente: o modelo pode **pedir** ferramentas do próprio aplicativo, que o aplicativo executa; as tarefas de sugestão continuam sem ferramentas.

- **Formato do MCP, sem servidor:** cada ferramenta tem nome, descrição e `inputSchema` como no MCP (`Registry.mcp_list`) e vai ao Ollama no formato de chamada de função do `/api/chat`. O aplicativo é o hospedeiro: não há processo MCP nem porta aberta, então nenhum outro programa ou serviço de nuvem alcança o cofre por elas. Ferramentas de fora do aplicativo (busca, arquivos, rede) continuam proibidas.
- **Leitura:** resumo do projeto, contas e saldos, categorias, integrantes, busca de lançamentos com filtros (texto, período, conta ou categoria, integrante, marcador, valor, situação), detalhe de um lançamento, despesas por categoria e por estabelecimento, resumo do mês, orçamento, marcadores, regras e itens importados pendentes; e “mostrar no Livro”, que só oferece um botão com o filtro. No máximo 50 linhas por resposta, com o total. CPF e CNPJ não são alcançáveis.
- **Alteração, sempre com aprovação:** reclassificar, pôr ou tirar marcador, nomear estabelecimento, criar regra de categoria, orçamento do mês, registrar despesa ou receita numa conta e escolher a categoria de um item importado. A ferramenta primeiro confere tudo (nomes, ids, valores em centavos, tipos, datas) e descreve a mudança; a janela **Aprovar alteração** mostra exatamente o que muda, e só **Aprovar** a executa, como um passo de desfazer. Recusar não muda nada e o modelo é avisado. Alterações com histórico guardam no motivo a origem (`assistente, ollama:<modelo>:a1@<digest>`). Se o livro mudar entre a proposta e a aprovação e nada puder ser aplicado, o modelo recebe o erro, não um “aplicado”.
- **Respostas inválidas:** ferramenta desconhecida, argumento a mais ou faltando, tipo errado, valor com mais de duas casas ou como número de ponto flutuante, nome ou id inexistente, resposta vazia ou chamada escrita como texto voltam ao modelo como erro, para ele corrigir. **Três respostas inválidas seguidas interrompem a pergunta**; uma resposta válida zera a contagem. Uma pergunta tem no máximo 12 passos.
- **Dinheiro exato:** os números da resposta do Ollama são lidos como `Decimal` (`parse_float`), e um valor que chegue como `float` é recusado.
- **Modelo:** precisa declarar a capacidade `tools` (`/api/show`); sem ela, a tela diz que o modelo não aceita ferramentas. Conversa com 16 mil tokens de contexto, temperatura 0 e raciocínio desligado; instruções em `ai/prompts.py`, versão `a1`.
- **Nada guardado:** a conversa fica só na memória da tela e some ao fechar o cofre; não vai para o cofre, para o disco nem para o registro técnico.

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
