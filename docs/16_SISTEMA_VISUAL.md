# Sistema visual e de interação

Versão 1.2 • 02/10/2026. Complementa o `07` (telas e gráficos) com as regras de interface adotadas na revisão orientada pelos princípios de interação de desktop da Apple (HIG): hierarquia clara, conteúdo acima de cromo, teclado como recurso de primeira classe e consistência entre telas. A meta não é imitar a aparência do macOS: o alvo continua sendo Windows, com Qt Widgets.

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

## 3. Componentes (`src/opesvault/ui/components.py`)

| Componente | Uso |
|---|---|
| `PageHeader` | Título, contexto e ações de cada página |
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
| `MonthPicker` | Mês por extenso, com botões ‹ › do mesmo tamanho e moldura do seletor, e Alt+← / Alt+→ |
| `style_table`, `install_column_chooser` | Tabelas sem grade, zebradas, colunas escolhidas pelo botão direito e lembradas |

Formulários (`FormDialog`) usam rótulos alinhados e um botão com verbo ("Registrar", "Salvar correção"). O erro aparece **dentro** do formulário, sem segundo diálogo. A senha é conferida enquanto o usuário digita: o botão só se habilita quando as senhas coincidem.

## 4. Regras

1. Uma ação primária por tela. Comandos raros, avançados ou destrutivos ficam em menus (Investimentos: 15 botões viraram uma ação primária e três menus).
2. Cada ação mostra o que fez, de forma breve na barra de status ("Lançamento corrigido. A versão anterior ficou no histórico."). Diálogo só quando há decisão.
3. Estados vazios explicam a área e oferecem o próximo passo; filtros ativos sempre mostram "Limpar filtros".
4. Cor nunca é o único sinal: o cancelado tem texto "Cancelado", o saldo negativo tem sinal e o estado de salvamento tem texto.
5. A janela funciona a partir de ~900 × 640: filtros e grupos quebram linha, painéis laterais podem ser recolhidos e o inspetor se oculta sozinho.
6. Teclado:
   - Ctrl+S, Ctrl+W, Ctrl+F, Ctrl+1…9, F1, Ctrl+L;
   - Ctrl+Z e Ctrl+Shift+Z (ou Ctrl+Y) desfazem e refazem o que ainda não foi salvo; o menu Editar diz o que será desfeito ("Desfazer lançamento");
   - Enter edita no Livro;
   - na revisão de importação: Ctrl+Enter, Ctrl+Shift+Enter, F2, Ctrl+M, Delete, Ctrl+K e Ctrl+R (criar regra);
   - botão direito oferece os mesmos comandos de linha.
7. Gráficos usam a fonte da interface, uma paleta dessaturada e as cores do tema, sem moldura, e mantêm só a navegação (início, mover, zoom). Datas no eixo seguem o uso brasileiro ("mar/26", "01/03/26"). O nome do gráfico aparece no próprio gráfico; o subtítulo da página diz o período. A inspeção de um ponto aparece ao lado do gráfico, sem diálogo. Não se acrescenta gráfico para preencher espaço: na Visão geral, a distribuição por categoria só ganha barras neutras a partir de três categorias.
8. Preferências deste computador ficam fora do cofre, em `QSettings`, e nunca guardam dados financeiros. São elas:
   - geometria da janela;
   - largura e visibilidade da barra lateral;
   - colunas visíveis;
   - bloqueio por inatividade;
   - cofres recentes.

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

- **Pagar fatura:** a aba Faturas tem **Pagar…** (também duplo clique na fatura). O formulário já traz a conta, o valor restante e a data de hoje. Pagamento depois do vencimento quita primeiro a fatura vencida (`04` §5, `domain.cards.bills`); o formulário diz isso quando a data passa do vencimento.
- **Mês compartilhado:** o mês escolhido na Visão geral vale no Orçamento e é a segunda opção de período do Livro, que abre em "Todo o período" para não esconder lançamentos de quem chega pela barra lateral. Ao abrir o cofre, a Visão geral escolhe o último mês com movimento e os outros a seguem.
- **Salvar e seguir:** em "Salvar alterações antes de …?", **Salvar…** pede a senha e, quando o cofre grava, a ação interrompida continua sozinha: fechar a janela, fechar o cofre, abrir ou criar outro, restaurar. Se o salvamento falhar ou for cancelado, nada continua.
- **Configurações com um contrato:** o que é do cofre (backup, lembrete, IA) vale no cofre na hora e é gravado pelo Salvar da barra, como qualquer edição; o que é deste computador (cofres recentes, bloqueio) é gravado na hora. Não há botão Aplicar. Cada aba diz de qual tipo é. O bloqueio por inatividade é configurado só ali. Backup agora, restaurar e trocar senha também aparecem ali, além do menu Cofre.
- **Início:** Novo, Abrir e Restaurar. Os cofres recentes aparecem só depois de consentimento (`07` §1), com o caminho e nunca saldos ou nomes.
- **Correção no Livro:** Enter e duplo clique abrem o mesmo formulário do lançamento do dia a dia (valor, data, contas ou categoria, competência). **Corrigir partidas…** abre o editor completo. Competência é escolhida como mês, nunca digitada como `AAAA-MM`.
- **Importar:** uma ação primária por vez (**Importar arquivos…** sem documento aberto; **Aprovar prontos** com documento aberto). Arquivos podem ser arrastados para a tela. **Layouts suportados** abre a cobertura de layouts.
- **Operador:** só aparece na barra quando há mais de um integrante ativo.
- **Assistente:** contas entram por um formulário, uma por vez, com titulares marcados entre os integrantes; a conta preenchida conta mesmo sem "Adicionar conta", então uma família com uma conta só preenche e avança.
- **Orçamento do mês:** **Orçamento do mês…** abre todas as categorias de despesa numa grade, com o gasto do mês e o plano anterior ao lado; vazio é "sem plano". Uma gravação, um passo de desfazer. "Alterar valor…" segue para uma categoria só.
- **Relatórios:** o filtro muda com o gráfico e só existe onde o cálculo está definido: conta em Entradas e saídas e em Fluxo de caixa; integrante no Resultado (a visão por integrante do domínio); categoria em Despesas por categoria, que passa a mostrar a evolução mensal dela. O período termina no mês escolhido na Visão geral.
- **Integrantes:** nome e papel (titular ou dependente) num formulário; o papel identifica, não dá acesso.

## 6. Verificação

- `uv run python scripts/capturar_telas.py [--dark] [--size 900x640]` renderiza cada tela com dados sintéticos em `build/telas/`. Use antes e depois de mudar a interface.
- `tests/test_ui_design.py` cobre:
  - estado sem cofre;
  - estado de salvamento;
  - grupos e contador da barra lateral;
  - largura mínima com dados (≤ 1000 px);
  - limpar filtros;
  - erro inline;
  - temas claro e escuro.
- `tests/test_flows.py` cobre os fluxos do §5: aviso de fatura até o pagamento, aviso de orçamento, mês compartilhado e linha da Visão geral abrindo o Livro, Configurações sem Aplicar, salvar e seguir, correção pelo formulário simples, recentes só com consentimento e operador oculto com um integrante. As preferências do computador vão para um arquivo temporário, nunca para o perfil do usuário.

## 7. Fora do alcance desta revisão

- **Liquid Glass e materiais translúcidos:** não se aplicam a Qt Widgets no Windows.
- **Teste com leitor de tela real** (NVDA/Narrador), a fazer junto com os gates do Windows. Os controles principais já têm nome acessível.
