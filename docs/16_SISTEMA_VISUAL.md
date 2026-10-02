# Sistema visual e de interação

Versão 1.0 • 02/10/2026. Complementa o `07` (telas e gráficos) com as regras de interface adotadas na revisão orientada pelos princípios de interação de desktop da Apple (HIG): hierarquia clara, conteúdo acima de cromo, teclado como recurso de primeira classe e consistência entre telas. A meta não é imitar a aparência do macOS: o alvo continua sendo Windows, com Qt Widgets.

## 1. Arquitetura da janela

```
Barra de ferramentas:  [barra lateral] Família · arquivo        ● estado  [Salvar]  Operador
Barra lateral          Cabeçalho da página: título, contexto, ações
(grupos)               Conteúdo principal                     | Inspetor (quando útil)
```

- **Barra lateral:** destinos agrupados (Dia a dia, Cadastros, Patrimônio, Arquivo). É redimensionável e pode ser ocultada (Ctrl+Shift+B). Um contador mostra itens de importação aguardando revisão.
- **Barra de ferramentas:** só o essencial e sempre visível:
  - qual cofre está aberto;
  - se há alterações não salvas (ponto + texto, nunca só cor);
  - o botão Salvar, que vira ação primária quando há alterações;
  - o operador do histórico.
- **Cabeçalho de página:** título ("onde estou"), linha de contexto (contagem, mês, filtros) e as ações da página. Há no máximo uma ação primária por tela.
- **Inspetor:** no Livro financeiro, os detalhes do lançamento selecionado ficam ao lado da tabela, em vez de num diálogo. Some sozinho em janelas estreitas e volta quando há espaço; a escolha explícita do usuário prevalece.
- **Menus:** todo comando da barra também está no menu.
  - **Cofre:** arquivo, backup e exportação.
  - **Exibir:** barra lateral, busca e bloqueio.
  - **Ir:** seções, com Ctrl+1…9.
  - **Ajuda:** F1.
- **Sem cofre aberto:** a janela mostra um estado vazio com Novo cofre e Abrir cofre.

## 2. Fundamentos (`src/opesvault/ui/theme.py`)

- **Cores semânticas** (`Tokens`), em versões clara e escura:
  - superfícies: janela, conteúdo, elevado, alternado;
  - separador e texto em três níveis;
  - destaque, seleção, foco, hover;
  - positivo, negativo e alerta.

  O tema segue o modo do sistema e muda junto com ele. Widgets não usam cores fixas: escolhem um estilo por propriedade (`textStyle`, `role`, `tone`).
- **Espaçamento:** 4 / 8 / 12 / 16 / 24 px (dentro do controle, entre itens relacionados, entre grupos, entre seções). Raio de 6 px. Linhas de tabela de 26 px.
- **Tipografia:** fonte do sistema. Estilos: título de página, título de seção, corpo, secundário, legenda e número em destaque. A hierarquia vem de peso e cor, não só de tamanho.
- **Estilo Qt:** Fusion, para métricas iguais em todos os sistemas. Combos e campos de número mantêm o desenho nativo do Fusion, para não perder as setas.
- **Tradução:** os textos do próprio Qt (botões padrão, diálogos de arquivo) usam `qtbase_pt_BR`.

## 3. Componentes (`src/opesvault/ui/components.py`)

| Componente | Uso |
|---|---|
| `PageHeader` | Título, contexto e ações de cada página |
| `EmptyState` | O que é a área, por que está vazia e o que fazer |
| `Figures` / `Section` | Números-chave e grupos titulados, sem caixas |
| `menu_button` | Agrupa comandos secundários sem escondê-los |
| `button(role=…)` | Hierarquia: `primary`, padrão, `plain`, `destructive` |
| `flow_row` / `FlowLayout` | Filtros e ações quebram linha em janelas estreitas |
| `MonthPicker` | Mês por extenso, com ‹ › e Alt+← / Alt+→ |
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
   - Enter edita no Livro;
   - na revisão de importação: Ctrl+Enter, Ctrl+Shift+Enter, F2, Ctrl+M, Delete e Ctrl+K;
   - botão direito oferece os mesmos comandos de linha.
7. Gráficos usam as cores do tema, sem moldura. Mantêm só a navegação (início, mover, zoom). A inspeção de um ponto aparece ao lado do gráfico, sem diálogo.
8. Preferências deste computador ficam fora do cofre, em `QSettings`, e nunca guardam dados financeiros. São elas:
   - geometria da janela;
   - largura e visibilidade da barra lateral;
   - colunas visíveis;
   - bloqueio por inatividade;
   - cofres recentes.

## 5. Verificação

- `uv run python scripts/capturar_telas.py [--dark] [--size 900x640]` renderiza cada tela com dados sintéticos em `build/telas/`. Use antes e depois de mudar a interface.
- `tests/test_ui_design.py` cobre:
  - estado sem cofre;
  - estado de salvamento;
  - grupos e contador da barra lateral;
  - largura mínima com dados (≤ 1000 px);
  - limpar filtros;
  - erro inline;
  - temas claro e escuro.

## 6. Fora do alcance desta revisão

- **Desfazer/refazer:** o domínio registra cada alteração com motivo e oferece estorno e cancelamento, mas não tem pilha de desfazer; criá-la exige decisão sobre o histórico.
- **Arrastar e soltar** arquivos na importação.
- **Liquid Glass e materiais translúcidos:** não se aplicam a Qt Widgets no Windows.
- **Teste com leitor de tela real** (NVDA/Narrador), a fazer junto com os gates do Windows. Os controles principais já têm nome acessível.
