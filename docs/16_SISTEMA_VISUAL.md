# Sistema visual e de interação

Versão 1.4 • 03/10/2026. Complementa o `07` (telas e gráficos) com as regras de interface adotadas na revisão orientada pelos princípios de interação de desktop da Apple (HIG): hierarquia clara, conteúdo acima de cromo, teclado como recurso de primeira classe e consistência entre telas. A meta não é imitar a aparência do macOS: o alvo continua sendo Windows, com Qt Widgets.

> **07/10/2026:** as regras de interação continuam valendo na web (`18` §5); os nomes de widgets Qt e de `ui/theme.py` são históricos, e os componentes equivalentes estão em `web/packages/ui`.

## 1. Arquitetura da janela

```
Barra de ferramentas:  [barra lateral] Família arquivo      ● estado  [Salvar] │ Operador [▾]
Barra lateral          Cabeçalho da página: título, contexto, ações
(grupos)               Conteúdo principal                     | Inspetor (quando útil)
Configurações (rodapé)
```

- **Barra lateral:** destinos agrupados (Dia a dia, Cadastros, Acompanhamento, Arquivo), com Configurações fixa no rodapé, por tratar do aplicativo e não do dinheiro da família. Itens de 28 px; o selecionado tem fundo neutro discreto e texto em semibold, sem a cor de destaque. É redimensionável e pode ser ocultada (Ctrl+Shift+B). Um contador mostra itens de importação aguardando revisão.
- **Barra de ferramentas:** só o essencial e sempre visível:
  - qual cofre está aberto: o nome da família em destaque e o nome do arquivo como texto secundário;
  - se há alterações não salvas (ponto + texto, nunca só cor), agrupado com o botão Salvar, que vira ação primária quando há alterações;
  - o operador do histórico, separado por uma divisória.

  O título da janela é "Família — OpesVault", sem asterisco: o estado de salvamento fica só na barra.
- **Cabeçalho de página:** título ("onde estou"), linha de contexto (contagem, estado, filtros) e as ações da página. Há no máximo uma ação primária por tela. Uma informação aparece num só lugar: o mês fica no seletor, e o subtítulo diz só "Mês aberto" ou o estado do orçamento. Grupos de ações sem relação (navegar no tempo × fechar o mês) ficam separados por 24 px.
- **Inspetor:** no Livro financeiro, os detalhes do lançamento selecionado ficam ao lado da tabela, em vez de num diálogo. Some sozinho em janelas estreitas e volta quando há espaço; a escolha explícita do usuário prevalece.
- **Menus:** todo comando da barra também está no menu.
  - **Cofre:** arquivo, backup e exportação.
  - **Editar:** desfazer e refazer.
  - **Exibir:** barra lateral, busca e bloqueio.
  - **Ir:** seções, com Ctrl+1…9.
  - **Ajuda:** F1.
- **Atenção:** ao abrir o cofre, a Visão geral mostra o que vence, atrasou, estourou ou aguarda revisão. Cada aviso tem um botão para a tela onde se resolve, e o painel some até a próxima abertura se o usuário ocultá-lo.
- **Sem cofre aberto:** a janela mostra um estado vazio com Novo cofre e Abrir cofre.

- **Organização do código da janela** (revisão de 03/10/2026):
  - `ui/main_window.py` monta a janela, os menus e a barra e cuida da navegação e do estado de salvamento;
  - `ui/shell/` tem as partes: `Sidebar` e `WelcomePanel` são widgets; os comandos do cofre (`vault`), backups (`backups`), bloqueio visual (`screen_lock`) e cofres recentes (`recents`) são grupos de comandos tipados contra `shell/contract.py`;
  - páginas grandes são pacotes com um módulo por responsabilidade: `pages/ledger/` (página, `LedgerFilters`, modelo da tabela, inspetor, comandos de linha), `pages/investments/` (página, `InvestmentDetail`, formulário, eventos, negociações), `pages/tax/` (página, `rows.py` sem Qt, comandos, informes), `pages/imports/` (página, fila, revisão, IA local, rótulos) e `pages/accounts/` (página e abas sobre `PageTab`: contas bancárias, todas as contas, faturas, financiamentos, regras).

- **Termo na interface:** o cofre pertence a um **Projeto**. A interface diz "Projeto inteiro", "(projeto)" e "Nome do projeto", nunca "Família". Estes documentos continuam usando "família" para o mesmo conceito.

## 2. Fundamentos (`src/opesvault/ui/theme.py`)

- **Cores semânticas** (`Tokens`), em versões clara e escura:
  - superfícies: janela, conteúdo, elevado, alternado;
  - separador e texto em três níveis;
  - destaque, seleção, foco, hover;
  - positivo, negativo e alerta.

  O tema segue o modo do sistema e muda junto com ele. Widgets não usam cores fixas: escolhem um estilo por propriedade (`textStyle`, `role`, `tone`). O azul fica reservado para ação principal, seleção em tabelas e foco. O vermelho de valores negativos é dessaturado (`#a63830` no claro), e o sinal "-" continua presente.
- **Espaçamento:** 4 / 8 / 12 / 16 / 24 / 32 px (dentro do controle, entre itens relacionados, dentro de um grupo, entre grupos, entre seções da página). Raio de 6 px. Linhas de tabela de 26 px.
- **Tipografia:** uma família (Segoe UI no Windows), dois pesos. Corpo, navegação e tabelas com 10 pt (~13 px); a hierarquia vem de peso e cor, não só de tamanho. Algarismos tabulares (`tnum`) em toda a aplicação, para quantias alinharem em colunas.

  | Estilo (`textStyle`) | Uso | Tamanho |
  |---|---|---|
  | `title` | Título da página | 22 px, semibold |
  | `headline` | Título de seção | 15 px, semibold |
  | `strong` | Ênfase no corpo (nome do cofre) | corpo, semibold |
  | `secondary` | Contexto e rótulos | corpo, cinza |
  | `caption` | Descrições auxiliares e rótulos de números | 12 px, cinza |
  | `figure` | Valores principais | 26 px, semibold |
- **Estilo Qt:** Fusion, para métricas iguais em todos os sistemas. Combos e campos de número mantêm o desenho nativo do Fusion, para não perder as setas.
- **Tradução:** os textos do próprio Qt (botões padrão, diálogos de arquivo) usam `qtbase_pt_BR`.

## 3. Componentes (`src/opesvault/ui/components/`)

Importados de `opesvault.ui.components`; cada tipo de peça tem seu módulo: `basics` (texto, botões, menus, separadores, linhas), `layout` (`FlowLayout`, `flow_row`, `Adaptive`, `scroll_body`), `header` (`PageHeader`), `sections` (`EmptyState`, `Figures`, `Section`, `Collapsible`), `month` (`MonthPicker`) e `decisions` (`decide`, `confirm`).

| Componente | Uso |
|---|---|
| `PageHeader` | Título, contexto e ações de cada página. As ações ficam numa linha ao lado do título quando cabem; sem largura, descem para baixo dele e quebram linha (`FlowLayout`), e a largura mínima é a da maior ação |
| `ElidedLabel` | Uma linha com nome do usuário (projeto, arquivo, documento, investimento): corta com "…" e mostra o texto inteiro na dica; `text()` devolve o texto inteiro. Nunca alarga a janela |
| `EmptyState` | O que é a área, por que está vazia e o que fazer |
| `Figures` / `Section` | Números-chave e grupos titulados, sem caixas. Grupos lado a lado usam uma grade de colunas iguais, com título, descrição e números nas mesmas linhas |
| `summary_table` / `fit_to_rows` | Tabelas curtas de resumo (Visão geral, Orçamento, Recorrências, carteira de Investimentos): sem moldura nem zebra, divisórias entre linhas, altura igual ao conteúdo até um limite (depois rola). A coluna do nome ocupa a sobra; colunas numéricas à direita, cabeçalho incluído |
| `frameless` | Listas dentro de abas ou ao lado de um visualizador (Contas e cartões, Investimentos, Documentos, Configurações): sem moldura nem zebra, ocupando a altura da aba. A moldura fica só nas grandes áreas de trabalho que rolam (Livro, Importar), onde delimita a região rolada |
| `Section.add_actions` | As ações de um grupo ficam na linha do título dele, à direita, e não soltas acima do conteúdo; comandos raros vão para "Mais" |
| `scroll_body` | Corpo de página com várias seções: rola na vertical, com 32 px entre seções |
| `decide` / `confirm` | Decisões: o título é a pergunta ("Salvar alterações antes de fechar o cofre?"), o texto diz a consequência e cada botão diz o que faz ("Salvar…", "Descartar alterações", "Cancelar"). Sem ícone e sem Sim/Não |
| `menu_button` | Agrupa comandos secundários sem escondê-los |
| `button(role=…)` | Hierarquia: `primary`, padrão, `plain`, `destructive` |
| `flow_row` / `FlowLayout` | Filtros e ações quebram linha em janelas estreitas |
| `Adaptive` / `adaptive` | Partes relacionadas lado a lado quando há largura e uma abaixo da outra quando não há. A largura mínima é sempre a da forma empilhada, para que o arranjo largo nunca obrigue a janela a ficar larga. Usa folga de 32 px para não alternar com a barra de rolagem. `first_right` põe a primeira parte em cima quando empilhado e à direita quando largo (coluna lateral) |
| `ui/catalog_widgets.py` | Listas com busca (digitar código ou parte do nome): bancos pelo COMPE, grupos e códigos de Bens e Direitos, tipos de investimento |
| `pages/accounts/bank.py`, `ui/bank_dialogs.py` | Aba Contas bancárias e diálogos de conta bancária, valores em uma data (tabela por item, com "Ajustar o saldo") e investimento (novo ou características) |
| `ui/tax_dialogs/` | Diálogos do Imposto de renda, um módulo por ficha (`people`, `income`, `assets`, `reports`, `year`, com os campos comuns em `fields`): CPF/CNPJ, declarantes, natureza dos rendimentos (grade), contracheque, comprovantes, bem, informe (revisão linha a linha), tabela do ano, regras de renda variável, DARF |
| `select_id`, `select_combo`, `fit_columns` (`ui/common.py`) | Selecionar a linha de uma tabela ou lista, ou a opção de um combo, pelo id, comparando valores (`reveal`, manter a seleção ao atualizar). Nunca `QComboBox.findData`, que compara objetos Python por identidade e não acha um id lido de volta do cofre. Colunas do tamanho do conteúdo sem reservar a seta de ordenação em todas (só na ordenada) |
| `share_width` (`ui/common.py`) | Tabelas de trabalho (Livro): larguras base para todas as colunas; numa janela larga a sobra vai para as colunas de texto, em vez de virar uma faixa vazia. Uma coluna arrastada pelo usuário encerra a divisão automática |
| `PageTab` (`pages/accounts/tab.py`) | Aba com estado próprio: lê a sessão da página e avisa por ela (`changed`, `notify`, `navigate`), então uma alteração na aba é um passo de desfazer como outro qualquer |
| `while_alive` (`ui/background.py`) | Liga a resposta de um trabalho em segundo plano a uma página só enquanto ela existir; a resposta que chega depois de a janela fechar é descartada |
| `ui/preferences.py` | Único ponto que cria `QSettings` (preferências deste computador); os testes o desviam para um arquivo temporário |
| `MonthPicker` | Mês por extenso, com botões ‹ › do mesmo tamanho e moldura do seletor, e Alt+← / Alt+→ |
| `style_table`, `install_column_chooser` | Tabelas sem grade, zebradas, colunas escolhidas pelo botão direito e lembradas |
| `Collapsible` | Seção que se recolhe: o título é o botão (seta ▸/▾), as ações ficam na linha do título e somem quando recolhida. Com uma chave, a escolha do usuário (só o clique, não a mudança feita pelo código) fica neste computador |
| `ChartPanel` (`ui/chart_panel.py`) | Gráfico e tabela de valores do mesmo `Chart`, cada um num `Collapsible`. Clicar numa linha aponta o valor no gráfico; clicar no gráfico seleciona a linha. Fluxos mensais ganham linhas "Total" e "Média"; posições (saldos) não somam. "Exportar valores…" grava CSV com o aviso de arquivo sem cifra. `clear()` ao fechar o cofre |

Formulários (`FormDialog`) usam rótulos alinhados e um botão com verbo ("Registrar", "Salvar correção"). O formulário rola dentro do diálogo, que nunca passa de 85% da altura da tela; listas que se editam ali mesmo (pessoas, operações) têm só "Fechar" (`close_only`). O erro aparece **dentro** do formulário, sem segundo diálogo. A senha é conferida enquanto o usuário digita: o botão só se habilita quando as senhas coincidem.

## 4. Regras

1. Uma ação primária por tela. Comandos raros, avançados ou destrutivos ficam em menus (Investimentos: 15 botões viraram uma ação primária e três menus).
2. Cada ação mostra o que fez, de forma breve na barra de status ("Lançamento corrigido. A versão anterior ficou no histórico."). Diálogo só quando há decisão.
3. Estados vazios explicam a área e oferecem o próximo passo; filtros ativos sempre mostram "Limpar filtros".
4. Cor nunca é o único sinal: o cancelado tem texto "Cancelado", o saldo negativo tem sinal e o estado de salvamento tem texto.
5. A janela funciona a partir de ~900 × 640: filtros, grupos e as ações do cabeçalho quebram linha, painéis laterais podem ser recolhidos e o inspetor se oculta sozinho. O alvo do produto, porém, é **1920 × 1080**, e ali uma coluna única deixa metade da tela vazia. Por isso, a partir de certa largura do conteúdo, as partes relacionadas ficam lado a lado (`Adaptive`):

   | Tela | Lado a lado quando largo | A partir de |
   |---|---|---|
   | Todas com `ChartPanel` (Orçamento, Contas, Relatórios, Metas, Visão geral) | gráfico (3/5) e tabela de valores (2/5); o gráfico fica 40% mais alto | 1000 px do painel |
   | Visão geral | o mês à esquerda; Atenção e "Antes de fechar o mês" numa coluna à direita (2/7), que some quando está vazia. Estreita: em cima, como antes | 1300 px |
   | Orçamento | categorias do mês e, ao lado, o histórico da categoria selecionada | 1200 px |
   | Calendário | o calendário e a lista de vencimentos | 1200 px |
   | Investimentos | Evolução e Avaliações; Resultado acumulado e Movimentos; Rentabilidade e Lotes | 1200 px |
   | Recorrências | Assinaturas e contas fixas e "Parecem recorrentes" | 1400 px |
   | Reembolsos e acertos | Acertos entre integrantes e Acertos registrados | 1300 px |

   Nas áreas de trabalho com divisória, a sobra se reparte: no Livro, 3:1 entre a tabela e o inspetor, e as colunas Descrição, De → Para e Tipo crescem (`share_width`); em Importar, 1:4:3 entre documentos, revisão e original. O PDF original se ajusta à largura do visualizador (escala de 0,75 a 2,5) e é desenhado de novo quando a largura muda. Os gráficos refazem as margens ao mudar de tamanho, para os rótulos do eixo não serem cortados. Uma tabela de muitas colunas não vira coluna estreita: a lista de contas continua com a largura toda, e o gráfico de saldo abaixo dela é que fica ao lado dos valores.
6. Teclado:
   - Ctrl+S, Ctrl+W, Ctrl+F, Ctrl+1…9, F1, Ctrl+L;
   - Ctrl+Z e Ctrl+Shift+Z (ou Ctrl+Y) desfazem e refazem o que ainda não foi salvo; o menu Editar diz o que será desfeito ("Desfazer lançamento");
   - Enter edita no Livro;
   - na revisão de importação: Ctrl+Enter, Ctrl+Shift+Enter, F2, Ctrl+M, Delete, Ctrl+K e Ctrl+R (criar regra);
   - botão direito oferece os mesmos comandos de linha.
7. Gráficos usam a fonte da interface, uma paleta dessaturada e as cores do tema, sem moldura, e mantêm só a navegação (início, mover, zoom). Datas no eixo seguem o uso brasileiro ("mar/26", "01/03/26"). O nome do gráfico aparece no próprio gráfico; o subtítulo da página diz o período. A inspeção de um ponto aparece ao lado do gráfico, sem diálogo. Não se acrescenta gráfico para preencher espaço: na Visão geral, a distribuição por categoria só ganha barras neutras a partir de três categorias.
8. Preferências deste computador ficam fora do cofre, em `QSettings` (sempre por `ui/preferences.py`), e nunca guardam dados financeiros. São elas:
   - seções recolhidas ou abertas (`secoes/…`);
   - geometria da janela;
   - largura e visibilidade da barra lateral;
   - colunas visíveis;
   - bloqueio por inatividade;
   - cofres recentes.

9. **Gráfico e tabela juntos, abas só para objetos diferentes** (revisão de 03/10/2026). Os números de um gráfico ao longo do tempo aparecem na mesma tela, logo abaixo, numa tabela que pode ser recolhida (`ChartPanel`); nunca numa aba separada. Abas separam coisas diferentes (Contas, Cartões, Faturas, Financiamentos, Categorias; as seções de Configurações). Investimentos trocou as seis abas (Evolução, Resultado, Avaliações, Movimentos, Lotes, Rentabilidade) por seções recolhíveis numa página só.
10. Toda tabela ou gráfico novo é limpo quando o cofre fecha (TA-31): `ChartPanel.clear()`, `ChartWidget.clear()` e `setRowCount(0)` no ramo sem sessão de `refresh`.
11. Largura mínima (revisão de 03/10/2026): nenhuma página pode exigir mais que ~630 px de conteúdo, para caber em 900 px com a barra lateral. Barras de ação de abas usam `flow_row`, nunca `hbox`; a barra lateral se mede pelo nome mais longo em negrito, com o contador, sem cortar nomes. Conferir com `minimumSizeHint` da janela, não só pela captura.
12. Tabelas que ordenam começam na ordem em que os dados chegam (sem indicador de ordenação), não na primeira coluna de trás para frente. Barras de rolagem são finas e seguem o tema. Listas com um item a examinar (documentos, faturas, investimentos) já abrem com um selecionado: a fatura em aberto mais antiga, o primeiro documento.
13. Gráficos: a legenda fica na linha do título, à direita, e desce para uma linha própria quando os dois não cabem; as notas abaixo quebram linha conforme a largura. Rótulos de mês ficam na horizontal até 8 meses. Uma série de outra ordem de grandeza (juros e amortização da parcela ao lado do saldo devedor) usa a escala da direita (`Series.axis = "right"`), e a nota diz qual escala é qual.
14. Orientação curta ("Selecione um investimento.", "Nada a copiar…", o resultado de uma aprovação) vai para a barra de status com `Page.notify`; `QMessageBox` fica para erros e relatórios que precisam ser lidos.
15. Regras que aprendem: a aba Contas e cartões › Regras mostra as regras do usuário (com "contrariada N de M vezes" quando a família escolhe outra categoria para o que a regra pega) e, abaixo, as **sugeridas pelo uso**: descrições categorizadas do mesmo jeito ao menos três vezes, que viram regra só com "Criar regra…". No lançamento manual, a descrição sugere a categoria de costume até a pessoa escolher outra, com uma linha dizendo que a sugestão veio do uso.

## 5. Fluxos: ver, ir ao ponto e concluir

Regra: quem vê um problema chega ao objeto e ao comando que o resolve, sem procurá-lo em outra seção.

| Ponto de partida | Para onde leva | Implementação |
|---|---|---|
| Aviso de fatura (vencida ou a vencer) | Contas e cartões › Faturas, no cartão e na fatura do aviso, com **Pagar…** já aberto | `Alert.ref` = (cartão, mês); `AccountsPage.reveal` |
| Previsão atrasada | Recorrências, com a previsão selecionada e **Vincular…** aberto | `RecurrencesPage.reveal` |
| Orçamento estourado ou perto do limite | Orçamento no mês do aviso, com a categoria selecionada | `BudgetPage.reveal` |
| Itens aguardando revisão | Importar, com o documento aberto e o foco nos itens (Ctrl+Enter) | `ImportPage.reveal` |
| Linha de saldo ou de categoria na Visão geral | Livro financeiro filtrado pela conta ou categoria, no mesmo mês | `LedgerPage.reveal(("filter", conta, mês))` |
| Documento | A revisão do lote ligado a ele (**Abrir na revisão**) | `DocumentsPage` |
| Ponto de um gráfico mensal em Relatórios | Livro filtrado no mês do ponto, com a conta, a categoria ou o integrante do filtro (**Ver lançamentos**) | `ReportsPage._ledger_ref` |
| Composição da carteira (Investimentos › Mais) e Projeção de compromissos (Recorrências › Mais) | O gráfico correspondente em Relatórios | `ReportsPage.reveal` |
| Aviso de parcela de financiamento | Contas e cartões › Financiamentos, com a parcela selecionada e **Pagar…** aberto | `Alert.ref` = ("loan", plano, nº); `AccountsPage.reveal` |
| Aviso de saldo previsto negativo | Relatórios › Saldo projetado | `ReportsPage.reveal("projected_balance")` |
| Aviso de saldo diferente do banco | Contas e cartões › Contas, com a conta e as conferências abertas | `Alert.ref` = ("check", conta) |
| Aviso de valor de assinatura que mudou | Recorrências › Assinaturas e contas fixas, com a regra selecionada | `Alert.ref` = ("rule", regra) |
| Vencimento no Calendário | A fatura, a parcela ou a previsão, com a ação aberta quando pendente | `AgendaPage.open_selected` |
| Marcador em Relatórios | Livro filtrado pelo marcador | `LedgerPage.reveal(("tag", nome))` |
| Aviso de possível duplicidade ou valor fora do comum | Livro filtrado na conta e nos dias do aviso; **Ações › Está certo** silencia | `Alert.ref` = ("filter", conta, (de, até)) |
| Aviso de backup antigo ou ausente | Configurações | `MainWindow.backup_alerts` (lê a pasta; o domínio não lê disco) |
| Comprovante no inspetor do Livro | Documentos, com o arquivo selecionado (PDF ou imagem) | `DocumentsPage.reveal(documento)` |

- **Pagar fatura:** a aba Faturas tem **Pagar…** (também duplo clique na fatura). O formulário já traz a conta, o valor restante e a data de hoje. Pagamento depois do vencimento quita primeiro a fatura vencida (`04` §5, `domain.cards.bills`); o formulário diz isso quando a data passa do vencimento.
- **Mês compartilhado:** o mês escolhido na Visão geral vale no Orçamento e é a segunda opção de período do Livro, que abre em "Todo o período" para não esconder lançamentos de quem chega pela barra lateral. Ao abrir o cofre, a Visão geral escolhe o último mês com movimento e os outros a seguem.
- **Salvar e seguir:** em "Salvar alterações antes de …?", **Salvar…** pede a senha e, quando o cofre grava, a ação interrompida continua sozinha: fechar a janela, fechar o cofre, abrir ou criar outro, restaurar. Se o salvamento falhar ou for cancelado, nada continua.
- **Configurações com um contrato:** o que é do cofre (backup, lembrete, IA) vale no cofre na hora e é gravado pelo Salvar da barra, como qualquer edição; o que é deste computador (cofres recentes, bloqueio) é gravado na hora. Não há botão Aplicar. Cada aba diz de qual tipo é. O bloqueio por inatividade é configurado só ali. Backup agora, restaurar e trocar senha também aparecem ali, além do menu Cofre.
- **Início:** Novo, Abrir e Restaurar. Os cofres recentes aparecem só depois de consentimento (`07` §1), com o caminho e nunca saldos ou nomes.
- **Correção no Livro:** Enter e duplo clique abrem o mesmo formulário do lançamento do dia a dia (valor, data, contas ou categoria, competência). **Corrigir partidas…** abre o editor completo. Competência é escolhida como mês, nunca digitada como `AAAA-MM`.
- **Importar:** uma ação primária por vez (**Importar arquivos…** sem documento aberto; **Aprovar prontos** com documento aberto). Arquivos podem ser arrastados para a tela. **Layouts suportados** abre a cobertura de layouts. Com a IA local ligada, **Sugerir com IA (N)** aparece ao lado das ações, a consulta começa sozinha depois de importar e uma linha discreta mostra o progresso com **Cancelar**; a revisão continua liberada enquanto isso.
- **IA local em todas as telas** (`ui/local_ai.py`): um só contrato. O botão ou comando só aparece com a IA ligada (Configurações › IA local); a consulta corre em segundo plano numa linha discreta com progresso e **Cancelar** (`AiRunRow`), sem bloquear a tela; Ollama desligado ou modelo ausente dizem o que fazer. O que a IA propõe para dados que já estão no livro passa por uma lista de conferência (`AiReviewDialog`): uma linha por mudança, todas marcadas, cada uma pode ser desmarcada e um nome pode ser ajustado com dois cliques; nada muda antes de **Aplicar**, e a aplicação é um passo de desfazer. No **Livro**, o botão **IA local** (ao lado de Ações) sugere outra categoria ou nomes de estabelecimentos para os lançamentos selecionados (dois ou mais) ou, sem seleção, para todos os exibidos. No **Novo lançamento**, quando o histórico não conhece a descrição, **Perguntar à IA local** seleciona a categoria sugerida, e a escolha feita à mão durante a consulta prevalece. Em **Configurações**, a porta do Ollama (deste computador) e **Verificar Ollama**, que diz também se o modelo coube na GPU.
- **Assistente:** conversa numa área de leitura, com a atividade de cada ferramenta em itálico e atalhos “Ver no Livro” abaixo; pergunta numa linha com **Enviar**; exemplos de perguntas enquanto a conversa está vazia; sem a IA ligada, um estado vazio leva a Configurações. Cada alteração proposta abre **Aprovar alteração** (`ApprovalDialog`, `ui/local_ai.py`) com **Aprovar** e **Recusar**.
- **Operador:** só aparece na barra quando há mais de um integrante ativo.
- **Assistente:** contas entram por um formulário, uma por vez, com titulares marcados entre os integrantes; a conta preenchida conta mesmo sem "Adicionar conta", então uma família com uma conta só preenche e avança.
- **Orçamento do mês:** **Orçamento do mês…** abre todas as categorias de despesa numa grade, com o gasto do mês e o plano anterior ao lado; vazio é "sem plano". Uma gravação, um passo de desfazer. "Alterar valor…" segue para uma categoria só.
- **Relatórios:** o filtro muda com o gráfico e só existe onde o cálculo está definido: conta em Entradas e saídas e em Fluxo de caixa; integrante no Resultado (a visão por integrante do domínio); categoria em Despesas por categoria, que passa a mostrar a evolução mensal dela. O período termina no mês escolhido na Visão geral.
- **Integrantes:** nome e papel (titular ou dependente) num formulário; o papel identifica, não dá acesso.

## 6. Verificação

- `uv run python scripts/capturar_telas.py [--dark] [--size 900x640]` renderiza cada tela com dados sintéticos em `build/telas/`. Use antes e depois de mudar a interface, em 1920x1080 (o alvo), 1280x800 e 900x640.
- `tests/test_ui_design.py` cobre:
  - estado sem cofre;
  - estado de salvamento;
  - grupos e contador da barra lateral;
  - largura mínima com e sem cofre (≤ 1000 px; ~880 px no Linux);
  - arranjo largo e estreito: `Adaptive`, gráfico ao lado dos valores, coluna de Atenção, colunas do Livro, ações do cabeçalho e PDF ajustado à largura;
  - limpar filtros;
  - erro inline;
  - temas claro e escuro.
- `tests/test_every_screen.py` vale para todas as telas de uma vez, com o cofre de demonstração (`tests/demo_vault.py`):
  - fechar o cofre não deixa nome nem valor do cofre em nenhuma página, aba, combo, lista, dica ou tabela (TA-31);
  - cada botão e cada item de menu de cada página e aba é acionado, sem e com a primeira linha selecionada, e num cofre novo e vazio, com todos os diálogos cancelados: nenhum erro escapa, e um clique que altera o livro fecha o próprio passo de desfazer;
  - cada página e aba cabe em 900 px com dados;
  - nenhum widget fixa cor ou fonte, só `ui/preferences.py` cria `QSettings` e nada usa `findData`.
- `tests/test_flows.py` cobre os fluxos do §5: aviso de fatura até o pagamento, aviso de orçamento, mês compartilhado e linha da Visão geral abrindo o Livro, Configurações sem Aplicar, salvar e seguir, correção pelo formulário simples, recentes só com consentimento e operador oculto com um integrante. As preferências do computador vão para um arquivo temporário, nunca para o perfil do usuário.

## 7. Fora do alcance desta revisão

- **Liquid Glass e materiais translúcidos:** não se aplicam a Qt Widgets no Windows.
- **Teste com leitor de tela real** (NVDA/Narrador), a fazer junto com os gates do Windows. Os controles principais já têm nome acessível.

## 8. Web (docs/18)

Fase W7 da migração. O sistema visual acima foi portado para `web/packages/ui` (tokens, componentes e animações) e a janela para `web/apps/app` (shell, rotas, início). As regras do §4 e os fluxos do §5 continuam valendo; o que muda na web está abaixo.

### 8.1 Tokens

- **Onde:** `packages/ui/src/styles/tokens.css` (variáveis CSS `--ov-*`) e `src/tokens.ts` (o que o código precisa: espaçamento, faixas, durações, curvas, molas, cores de série).
- **Cores:** as mesmas de `ui/theme.py`, com acréscimos para a web: `sunken` (poços e esqueletos), `separator-strong` (borda de controles), `accent-fill` (fundo do botão primário, separado de `accent` para que o texto branco tenha contraste AA também no escuro), versões suaves de destaque, positivo, negativo e alerta, `scrim` e três sombras. O alerta claro ficou um pouco mais escuro (`#8a5a00`) para manter AA sobre o fundo suave; a seleção inativa do escuro ficou `#323238` para o vermelho de valores negativos manter 4,5:1 numa linha selecionada.
- **Tema:** claro por padrão; o escuro segue o sistema (`prefers-color-scheme`) a menos que o usuário escolha. A escolha fica em `data-theme` no `<html>` e é uma preferência deste aparelho (`apps/app/src/preferences.ts`, o único módulo que usa `localStorage`).
- **Tailwind CSS v4:** `packages/ui/src/styles/index.css` mapeia os tokens em `@theme inline` (`bg-content`, `text-secondary`, `text-title`, `rounded-md`, `shadow-lg`…). A paleta padrão do Tailwind foi removida: não existe classe de cor fora dos tokens. Faixas como variantes: `tablet:` (640), `medium:` (1024), `wide:` (1440).
- **Tipografia:** Inter variável embutida (`@fontsource-variable/inter`, sem fonte remota), corpo de 14 px, legenda 12, seção 16, título 22, número-chave 28, dois pesos e algarismos tabulares em toda a aplicação.
- **Gráficos:** seis cores de série em ordem fixa (paleta validada para claro e escuro), lidas dos tokens em tempo de execução.

### 8.2 Movimento

- Durações de 120, 200 e 320 ms; curvas `standard`, `enter` e `exit`; molas para diálogo, folha, painel e indicador (`tokens.ts`, `motion.tsx`).
- Só `transform` e `opacity` animam. Animam: troca de página (deslize curto e fade), diálogos e folhas (mola), avisos, inspetor, indicador da aba e da barra lateral, conteúdo de seções recolhíveis, números da Visão geral (`NumberTicker`, contado com inteiros exatos: o último quadro é o valor exato) e gráficos (entrada e troca de dados).
- `prefers-reduced-motion`: o `MotionProvider` (`MotionConfig reducedMotion="user"`) tira deslocamentos e escalas; os componentes usam `useMotionPreset()`, que devolve só fades de 120 ms; o CSS limita transições a opacidade e cor e para o brilho dos esqueletos; os gráficos desenham sem animação.
- A troca de página anima só a entrada: o `Outlet` do roteador já mostra a página nova durante uma saída. `AnimatePresence` cuida de diálogos, folhas, avisos, inspetor e etapas do assistente inicial.

### 8.3 Componentes (`packages/ui/src/components`)

Com o mesmo nome dos do desktop sempre que existem, para as regras do CLAUDE.md continuarem valendo.

| Componente | Na web |
|---|---|
| `PageHeader` | Título, contexto e ações; a ação primária tem um espaço próprio (`primary`), então uma tela não consegue ter duas. As ações quebram linha abaixo do título por container query |
| `EmptyState`, `Section`, `Figure` | Como no desktop |
| `Collapsible` | O título é o botão; ações somem quando recolhida; `prefKey` lembra só o clique do usuário |
| `ChartPanel` | Gráfico (ECharts carregado sob demanda, canvas, tema dos tokens, tooltip, eixo secundário, "Exportar imagem") e tabela dos mesmos valores, cada um num `Collapsible`, lado a lado a partir de 1000 px do painel. Fluxos ganham "Total" e "Média" calculados com inteiros exatos. Desconhecido aparece como "—" e não é desenhado como zero |
| `Adaptive` | Grade com container query: empilhada por padrão, lado a lado a partir de 720, 1000, 1200, 1300 ou 1400 px do contêiner; `firstRight` |
| `ElidedText` | Uma linha com "…" e o texto inteiro na dica |
| `DataTable` | TanStack Table v9 (ordenação, visibilidade) e TanStack Virtual (linhas). Cabeçalho fixo, prioridade de colunas (2 a partir de 720 px, 3 a partir de 960), seleção pelo id, setas, Home/End, Page Up/Down e Enter; vira lista de cartões abaixo de 640 px de contêiner. Começa na ordem dos dados |
| `Button`, `IconButton` | `primary`, `secondary`, `ghost`, `danger`; `tone`; `busy`. O botão de ícone tem nome acessível e dica |
| `Dialog`, `Sheet`, `Overlay` | `<dialog>` nativo (camada superior, página inerte, Esc) com o painel animado; abaixo de 640 px o diálogo vira folha de baixo. Não usa o Radix Dialog porque o bloqueio de rolagem dele injeta `<style>`, que a CSP recusa |
| `decide` / `confirm` | Promessas; o título é a pergunta, cada botão diz o que faz, Cancelar devolve `null`; numa decisão destrutiva o foco começa em Cancelar. Precisa de `<DecisionHost />` |
| `notify` / `Toaster` | Avisos curtos numa região `polite`, com uma ação opcional ("Desfazer"); param enquanto o ponteiro ou o foco estão neles |
| `MenuButton` / `menuButton` | Radix DropdownMenu não modal; itens, separadores, rótulos e grupos de rádio |
| `Tabs` | Radix Tabs com indicador animado; só para objetos diferentes |
| `Select`, `Combobox` | Valor é sempre o id (texto); `optionById` compara valores. Popover do Radix com `listbox` ARIA |
| `TextField`, `MoneyField`, `DateField`, `Checkbox`, `Switch`, `RadioGroup` | Rótulo visível, dica e erro em texto. `MoneyField` aceita "1.234,56", guarda o texto como digitado e entrega o decimal canônico ("1234.56") para a página converter em `Dec`; `DateField` lê dd/mm/aaaa |
| `MonthPicker` | Mês por extenso, ‹ › e Alt+←/→; o mês abre um ano com os doze meses |
| `Badge`, `Skeleton`, `NumberTicker`, `StatusPill` | Contagens com texto para leitor de tela; esqueleto sem brilho com movimento reduzido; estado de sincronização com ponto, forma e texto (sincronizado, pendente, sincronizando, sem conexão, conflito, somente leitura, bloqueado) |
| `Inspector` | Coluna lateral em ≥ 1440 px, folha deslizante entre 1024 e 1439, oculto abaixo |
| `Sidebar`, `BottomNav`, `CommandPalette`, `LockScreen` | Navegação por links reais (abrem em outra aba), contagens no nome acessível; paleta com busca sem acento |

Os textos de dinheiro e datas passam por `format.ts`: nada de `float` para dinheiro; somas, médias (`ROUND_HALF_UP`) e a contagem do `NumberTicker` usam inteiros escalados.

### 8.4 Janela e faixas (`apps/app`)

- **Barra superior:** marca, nome do projeto (e "Operando como…" quando há mais de um integrante), busca (Ctrl+K), estado de sincronização, desfazer e refazer, ajuda, Bloquear e o menu da conta (operador, aparência, atalhos, trocar de projeto, sair).
- **Barra lateral:** os grupos e a ordem do `main_window.py` (Dia a dia, Cadastros, Acompanhamento, Arquivo), Configurações fixa no rodapé, contagens em Visão geral e Importar e revisar.

  | Faixa | Largura | Navegação |
  |---|---|---|
  | Larga | ≥ 1440 | Barra lateral fixa (Ctrl+Shift+B a recolhe em trilho de ícones), inspetor ao lado |
  | Média | 1024–1439 | Barra lateral recolhível em trilho de ícones; inspetor em folha |
  | Tablet | 640–1023 | Gaveta lateral |
  | Celular | < 640 | Barra inferior com Visão geral, Livro, Importar e Contas, mais "Mais" numa folha com todas as seções |

- **Teclado:** Alt+1…9 (as nove primeiras seções), `g` + letra para qualquer seção (v, o, c, l, i, a, r, n, e, s, m, b, p, d, f), Ctrl+K ou ⌘K, F1, Ctrl+Z / Ctrl+Shift+Z (ou Ctrl+Y) ligados a um contexto de desfazer que por enquanto diz "Nada a desfazer.", Ctrl+Shift+B e Ctrl+Shift+L (bloquear). Atalhos de uma tecla não disparam enquanto se digita nem com um diálogo aberto; dentro de um campo, Ctrl+Z é o desfazer do próprio texto. Um link "Pular para o conteúdo" abre a ordem de tabulação, e uma navegação pelo teclado leva o foco ao conteúdo da página nova.
- **Arquivos soltos** em qualquer tela vão para Importar e revisar.
- **Antes do projeto:** boas-vindas, entrar, criar conta, projetos (abrir com a senha do projeto), novo projeto (senha compartilhada e a chave de recuperação mostrada uma vez, com confirmação de que foi guardada) e o assistente inicial (integrantes, contas, cartões, conclusão; o formulário preenchido conta sem "Adicionar"). As telas chamam `AppServices` (`src/services/types.ts`); por enquanto responde uma implementação em memória (`fake.ts`), trocada pelo cofre e pelo servidor nas fases W1/W2. `?demo` abre o projeto de demonstração direto (só com a implementação em memória).
- Cada destino do `18` §6 tem uma rota com `PageHeader` e `EmptyState` até a fase que o constrói; `/catalogo` (desenvolvimento e build de teste) mostra todos os componentes em todos os estados.

### 8.5 Segurança no navegador e PWA

- CSP de produção em `src/security.ts`: `script-src 'self'`, `style-src 'self'`, nenhuma origem de terceiros, `object-src 'none'`, `base-uri 'none'`, `require-trusted-types-for 'script'` com uma única política (`default`) que aceita só o script do service worker e o HTML vazio (o ECharts limpa o contêiner com `innerHTML = ""`). O servidor enviará o cabeçalho (com `frame-ancestors 'none'`); o build leva a mesma política num `<meta>` para o `vite preview`. Por isso diálogos, selects e menus não usam as partes do Radix que injetam `<style>`, e o tooltip dos gráficos é texto no canvas.
- PWA (`vite-plugin-pwa`): instalável (manifesto em português, ícones gerados por `pnpm --filter @opesvault/app icons`), o shell abre sem conexão, versão nova é avisada ("Atualizar") e nunca aplicada em silêncio. O service worker não guarda respostas da API.

### 8.6 Verificação

```
cd web
pnpm check                                   # formatação, lint, tipos e testes (inclui packages/ui e apps/app)
pnpm --filter @opesvault/app e2e             # Playwright no build de produção (CSP e service worker reais)
pnpm --filter @opesvault/app screens         # capturas em web/build/telas
pnpm dev                                     # o app; /catalogo para os componentes
```

- **Vitest** (happy-dom): comportamento de diálogos e decisões, avisos, `MoneyField`, seleção por id na `DataTable` (inclusive com linhas relidas como objetos novos), ordenação exata, `Select` por id, movimento reduzido, formatação exata e as telas de entrada, conta, shell e bloqueio contra os serviços em memória.
- **Playwright** (Chromium em `/opt/pw-browsers`, nunca `playwright install`): cada destino, o catálogo e as telas de entrada sem erro no console (CSP e Trusted Types incluídos) e sem rolagem lateral em 1920×1080, 1280×800, 900×640, 768×1024 e 390×844, claro e escuro; axe sem violações (WCAG 2.2 AA) em páginas, catálogo, paleta, ajuda, menu, "Mais", bloqueio e telas de entrada; teclado no shell; fluxos de conta, projeto, assistente, bloqueio, troca de projeto e saída; movimento com e sem redução; manifesto e abertura sem conexão.
- **Capturas:** `catalogo-*`, `shell-visao-geral-*`, `shell-livro-*`, `shell-paleta-*`, `shell-gaveta-*` (tablet), `shell-mais-*` (celular), `shell-bloqueio-*` e `inicio-*`, cada uma em `LARGURAxALTURA-claro|escuro`. Revise antes e depois de mudar a interface, como as capturas do desktop.
