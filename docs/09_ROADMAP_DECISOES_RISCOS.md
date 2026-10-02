# Roadmap, decisões e riscos

Versão 1.3 • 02/10/2026. As fases 0 a 6 e 9 estão implementadas, assim como a revisão da interface (`16`). As fases 7, 8 e 10 foram feitas no que não depende do Windows nem de documentos reais. Este documento passa a planejar o que falta para o uso real e as funcionalidades que ainda faltam para uma família usar o OpesVault como ferramenta principal.

## 1. Fases e critérios de saída

### 1.1 Situação

| Fase | Entrega | Situação |
|---|---|---|
| 0 — Viabilidade | Cofre cifrado, worker transitório, medições | Concluída; gates Windows presumidos (`11` §4) |
| 1 — Fundamentos | Cofres, pessoas, contas, operações manuais e histórico | Concluída (`13` §2) |
| 2 — Documentos | Importação/revisão, layouts, conciliação, duplicatas | Concluída com layouts **sintéticos**, exceto notas de corretagem |
| 3 — Finanças | Caixa, competência, parcelas, recorrências e fechamento | Concluída |
| 4 — Investimentos essenciais | Avaliações, aportes, resgates, simulador e gráficos | Concluída; exemplos A–F automatizados |
| 5 — Carteira detalhada | Lotes, eventos, TWR/XIRR/Dietz, notas de corretagem | Concluída |
| 6 — Consolidação | Backup/restauração, senha, exportações, instalador opcional | Concluída, sem execução real no Windows |
| 7 — Validação real | Ferramentas prontas (`scripts/validar_layouts.py`, rastreabilidade `15`) | **Aguarda** Windows e documentos reais |
| 8 — Desempenho | Gravação incremental, consultas indexadas, livro virtual | Parcial: abrir ~8,7 s (meta ≤ 5 s) |
| 9 — Uso diário | Assistente, edição completa, filtros, lote, teclado, F1, bloqueio | Concluída em código; falta o teste com uma pessoa |
| — Revisão da interface | Tokens claro/escuro, moldura, componentes, telas reorganizadas (`16`) | Concluída; falta conferir no Windows (Segoe UI, 150/200%, leitor de tela) |
| 10 — Robustez e distribuição | Fuzzing, logs só com códigos, licenças, SBOM | Parcial: versões fixadas, assinatura, ícone |

### 1.2 Próximas fases, por ordem de risco

O primeiro risco é o mesmo da versão anterior: o produto ainda não foi exercitado com documentos reais nem no Windows. Funcionalidade nova não compensa isso. Por isso as fases 7, 8 e 10 vêm antes, e as novas (11 a 14) entram depois, uma a uma.

| Fase | Entrega | Critério para avançar | Depende de |
|---|---|---|---|
| 7 — Validação real | Gates G0–G7; corpus privado com esperado conferido (`15` §2); layouts ajustados; notas de terceiros copiadas; leitor de tela e escalas 150/200% | G0–G7 aprovados; layouts prioritários com 3 documentos conferidos por versão; TA parciais (`15`) reavaliados | Máquina Windows; documentos reais |
| 8 — Desempenho (restante) | Documentos carregados sob demanda (a abertura traz só metadados; o worker entrega o PDF quando a tela pede); renderização de PDF fora da thread visual; medição no Windows | Abrir ≤ 5 s e UI ≤ 600 MiB com 50 mil lançamentos e 250 MiB, no Windows de referência | Fase 7 (máquina de referência) |
| 10 — Distribuição (restante) | Versões fixadas após G1; ícone; assinatura ou instrução para o SmartScreen; enxugar módulos Qt; roteiro de atualização com migração ensaiada | Instalador testado do zero numa máquina limpa; atualização preserva cofres e preferências | Fase 7; decisão sobre certificado |
| 11 — Rotina da família | §1.3 A | Jornada "revisão mensal" do `01` §3 feita em menos passos, medida antes e depois | Fase 7 (categorias reais) |
| 12 — Confiança e recuperação | §1.3 B | Erros de edição desfeitos sem estorno; backup comprovadamente restaurável | — |
| 13 — Patrimônio e impostos | §1.3 C | Relatório anual confere com os informes reais da família | Decisão do usuário sobre o escopo fiscal |
| 14 — Expansões | OCR local; novos layouts (Caixa, Banco do Brasil, Santander, informe de rendimentos, extratos de investimento); `.xlsx`; moedas estrangeiras com câmbio informado; benchmark de modelos Ollama | Cada expansão passa pelos critérios da fase 7 | Amostras reais e decisão por item |

As fases 11 e 12 podem andar em paralelo à 7, porque não dependem de documentos reais; só não devem atrasá-la.

### 1.3 Funcionalidades propostas

Critério de escolha: o que uma família precisa todo mês e hoje exige trabalho manual repetido, ou o que reduz o risco de perder ou errar dados. Cada item indica o porquê e se exige decisão (§4).

**A. Rotina da família (fase 11)**

| Item | Por quê | Decisão? |
|---|---|---|
| **Orçamento por categoria e mês**: limite planejado, realizado por competência, saldo restante e alerta ao passar do limite; cópia do mês anterior | É a pergunta mensal mais comum ("quanto ainda posso gastar?") | **Feito** (`13` §2.2); escopo aprovado pelo usuário |
| **Regras de categorização editáveis**: "descrição contém X → categoria Y", por conta ou cartão, criadas a partir de uma correção na revisão | Maior ganho de tempo na revisão de faturas | **Feito** (`13` §2.2) |
| **Alertas de vencimento ao abrir o cofre**: faturas e recorrências que vencem nos próximos dias, previsões sem realização, orçamento estourado e importações pendentes | O app é offline e não notifica; ao abrir, deve dizer o que pede atenção | **Feito** (`13` §2.2) |
| **Comprovantes em lançamentos manuais**: anexar PDF/imagem a qualquer operação, guardado cifrado como os documentos importados | Hoje só itens importados têm evidência; recibos de aluguel, médicos e escolas ficam fora | Não |
| **Drill-down**: clicar num número da Visão geral, numa barra ou numa categoria abre o Livro já filtrado | Liga "quanto" a "o quê" sem refazer filtros | Não |
| **Visão por integrante**: Visão geral e relatórios filtrados por integrante, com rateio, ao lado do consolidado (fecha o TA-18 e o TA-24) | Contas conjuntas e despesas divididas são o caso típico de família | Não |
| **Filtros salvos** no Livro ("Cartão da Ana este mês") | Revisão mensal repete os mesmos filtros | Não |
| **Arrastar arquivos** para "Importar e revisar" | Atalho óbvio no desktop | Não |
| **Relatório mensal para impressão/PDF** (resumo, categorias, faturas, pendências), com o mesmo aviso de exportação sem cifra | Conversa da família sobre o mês; hoje só há CSV/JSON | Não |

**B. Confiança e recuperação (fase 12)**

| Item | Por quê | Decisão? |
|---|---|---|
| **Desfazer/refazer na sessão** (Ctrl+Z / Ctrl+Shift+Z) para as edições ainda não salvas; depois de salvo, a correção continua por histórico e estorno | Erros de clique exigiam estorno com motivo | **Feito** (`13` §2.2); decidido: só o que não foi salvo |
| **Verificação de backup**: abrir um backup no worker (senha digitada nele) e conferir integridade e contagens; lembrete de "último backup há N dias" | Backup que nunca foi restaurado não é garantia (`03`) | Não |
| **Compactação opcional do histórico** antigo, com backup antes | O cofre cresce indefinidamente | Sim (já listada) |
| **Detecção de lançamentos suspeitos**: valor muito acima da média da categoria, possível cobrança duplicada no cartão, assinatura que mudou de valor | Pega erro de digitação e cobrança indevida, sem IA | Não |

**C. Patrimônio e impostos (fase 13)**

| Item | Por quê | Decisão? |
|---|---|---|
| **Fechamento do ano**: patrimônio em 31/12 por conta e investimento, rendimentos isentos e tributáveis informados, imposto retido, ganhos realizados por classe | Material de apoio para a declaração anual, a partir de dados já registrados | Sim: o `00` §5 exclui "declaração fiscal oficial"; isto seria apoio, não declaração |
| **Tabelas fiscais por classe**, parametrizadas e versionadas por data, usadas pelo simulador | Hoje as regras são informadas manualmente | Sim |
| **Metas de patrimônio ou reserva** (valor-alvo e data, com progresso) | Pedido comum de família; usa o patrimônio já calculado | Sim: entra no escopo |

### 1.4 Andamento e números

| Fase | Feito | Falta |
|---|---|---|
| 7 | `scripts/validar_layouts.py`; rastreabilidade TA-01…TA-36 (`15`): 31 automatizados, 5 parciais, nenhum pendente | Gates G0–G7; documentos reais; notas de terceiros |
| 8 | Gravação incremental; abertura em JSON com verificação de todas as páginas; consultas indexadas; livro virtual | Documentos sob demanda; PDF fora da thread visual; medir no Windows |
| 9 | Assistente; edição completa com rateio; filtros; lote; teclado; F1; bloqueio por inatividade | Jornadas feitas por uma pessoa sem ajuda, em 100/150/200%, só com teclado |
| Interface | Tokens claro/escuro; barra de ferramentas com estado de salvamento; barra lateral agrupada; inspetor; estados vazios; janela mínima de ~1456 para ~885 px | Conferência no Windows; leitor de tela |
| 10 | Fuzzing; logs só com códigos; licenças e SBOM; revisão do worker e das exportações | Versões fixadas; assinatura; ícone; módulos Qt |

Números do Linux de referência (50 mil lançamentos, 250 MiB de PDFs):

| Métrica | Antes | Agora | Meta da fase 8 |
|---|---|---|---|
| Salvar (Ctrl+S) | ~21 s | ~3,7 s | ≤ 3 s |
| Abrir | ~15 s | ~8,7 s | ≤ 5 s |
| Pico de RAM do worker ao salvar | ~820 MiB | ~50 MiB | ≤ 600 MiB |
| Pico de RAM da UI | ~760 MiB | ~580–690 MiB | ≤ 600 MiB |
| Filtrar o livro (50 mil linhas) | lento (tabela preenchida) | ≤ 0,2 s | ≤ 200 ms |

O piso da abertura é decifrar ~263 MB e interpretar 50 mil operações (~3,7 s só para interpretar). Carregar documentos sob demanda tira a maior parte dos bytes do caminho.

### 1.5 Dívida técnica conhecida

| Item | Efeito | Situação |
|---|---|---|
| Abertura acima da meta | ~8,7 s com 50 mil lançamentos | Aberto; fase 8 (documentos sob demanda) |
| Renderização de página PDF na thread visual (`PdfView`) | PDFs grandes podem travar a tela por instantes | Aberto; fase 8 |
| Regras de categorização fixas no código | Não se adaptam à família | Aberto; fase 11 |
| Telas de importação, contas e investimentos usam `QTableWidget` com `resizeColumnsToContents` a cada atualização | Bom para centenas de linhas; lento se crescerem muito | Aceitável; revisar se o uso real mostrar volumes maiores |
| Histórico cresce sem limite | Cofre maior com o tempo | Mitigado; compactação opcional na fase 12 |
| Layouts de faturas e extratos são sintéticos | Podem falhar com documentos reais | Aberto; fase 7 |
| Interface conferida só no Linux com fonte DejaVu | Métricas e quebras podem mudar com Segoe UI e escalas do Windows | Aberto; fase 7 |
| Itens resolvidos nesta rodada: salvar inteiro, tabelas cheias, consultas lineares, livro só com descrição, corrida importar/salvar | — | Resolvidos (ver `13` §2.1) |

## 2. Decisões arquiteturais

| ID | Decisão | Razão | Consequência |
|---|---|---|---|
| ADR-01 | Python + Qt Widgets | Stack aprovada e foco em documentos | Validar empacotamento e licenças |
| ADR-02 | Um SQLCipher por família | Cofre portátil com dados e PDFs | Arquivo e backup podem crescer |
| ADR-03 | Senha ao abrir e salvar | Preferência expressa do usuário | Sem autosave persistente |
| ADR-04 | Operações de cofre em processo transitório | Reduzir retenção deliberada de segredo | Snapshot em RAM e maior custo de memória |
| ADR-05 | Parsers por layout, IA auxiliar | Extração rastreável e verificável | Manutenção contínua de layouts |
| ADR-06 | Partidas dobradas no domínio | Evitar duplicação e conciliar patrimônio | Interface traduz conceitos contábeis |
| ADR-07 | Avaliação separada de movimento e custo | Distinguir saldo, aporte e rendimento | Dados incompletos limitam indicadores |
| ADR-08 | Tributos manuais/parametrizados inicialmente | Evitar regras fiscais universais incorretas | Simulações não são apuração legal |
| ADR-09 | Uma instância editora por cofre | Evitar conflitos e corrupção | Sem compartilhamento simultâneo |
| ADR-10 | Registro contínuo, visões mensais | Parcelas e histórico atravessam meses | Fechamento é estado, não arquivo separado |

ADR-01 a ADR-03 refletem escolhas aprovadas; os mecanismos específicos e demais ADRs são detalhamento proposto para implementação. Não alteram o requisito de processamento offline.

## 3. Registro de riscos

| Risco | Efeito | Resposta planejada |
|---|---|---|
| Mudança de layout bancário | Extração errada | Catálogo versionado, evidências e revisão |
| Poucas amostras | Falsa impressão de cobertura | Corpus autorizado e declaração por layout |
| Binding SQLCipher incompatível | Falha de distribuição | Gate técnico antes de construir demais módulos |
| Snapshot com muitos PDFs | RAM excessiva | Limite ensaiado e alertas prévios; rever estratégia se necessário |
| Suposta limpeza absoluta da RAM | Promessa de segurança falsa | Limitação documentada e processo transitório |
| Falha antes de salvar | Perda do trabalho em RAM | Estado visível e lembretes; explicar trade-off |
| Cópia incompleta durante escrita | Backup inválido | Snapshot consistente, fechamento e restauração testada |
| Impostos genéricos | Resultado líquido incorreto | Valores informados e regras explícitas/versionadas |
| Avaliações esparsas | Rentabilidade enganosa | Métodos condicionados à informação disponível |
| IA alucinando | Registros incorretos | Sem escrita direta, evidência e aprovação humana |
| Dois integrantes na conta conjunta | Dupla contagem | Perímetro e rateio explícitos |
| Arquivo perdido ou senha esquecida | Irrecuperabilidade | Backups e orientação sem falsa recuperação remota |

## 4. Decisões pendentes do usuário

| Decisão | Por que importa | Bloqueia |
|---|---|---|
| Desbloqueio após inatividade pede a senha do cofre (implementado assim; cofre nunca salvo desbloqueia sem senha) e o tempo padrão é 10 min | Equilíbrio entre proteção e incômodo | Revisável |
| Compactar o histórico antigo de alterações | Reduz o cofre, mas perde versões anteriores | Fase 12 (opcional) |
| Incluir **metas** de patrimônio no escopo (`00` §5); o orçamento já foi aprovado e implementado | Funcionalidade de valor mensal | Fase 13 |
| **Fechamento do ano** como material de apoio à declaração | O `00` §5 exclui declaração fiscal oficial; o apoio precisa de limite claro | Fase 13 |
| Certificado de assinatura de código | Evita alertas do SmartScreen no instalador | Fase 10 |
| Quando rodar os gates G0–G7 e qual é a máquina Windows de referência (RAM, disco, antivírus) | Sem isso, distribuição e metas de desempenho não têm base | Fases 7, 8 e 10 |
| Bancos e produtos prioritários, com documentos reais (faturas, extratos, CSV/OFX) | Layouts sintéticos só viram suporte com amostras | Fase 7 |
| Classes de investimento que a família usa e eventos necessários | Orienta regras por classe e layouts de extratos de investimento | Fases 13 e 14 |
| Modelo Ollama local, se a IA for usada | Escolha por benchmark, não por suposição | Fase 14 |
| Ícone do aplicativo | Distribuição | Fase 10 |

## 5. Controle de mudanças

Cada alteração de escopo registra motivo, documentos afetados, migração de dados, impacto de segurança e testes necessários. Propostas que introduzam cloud, retenção de chave para autosave, edição simultânea ou mudança de stack exigem nova decisão do usuário. Ajustes rotineiros de implementação dentro da arquitetura não exigem reaprovação de cada biblioteca auxiliar.

### Registro de mudanças

| Data | Mudança | Motivo | Documentos | Dados | Segurança | Testes |
|---|---|---|---|---|---|---|
| 02/10/2026 | Fase 0 encerrada com gates Windows presumidos aprovados; Nuitka opcional | Decisão do usuário | 11, CLAUDE.md | Nenhum | Gates G0–G7 seguem pendentes de execução real | Roteiro G0–G7 no doc 11 |
| 02/10/2026 | Importação de CSV e OFX, além de PDF | Formatos exportados pelos bancos são mais confiáveis que o texto de PDF (doc 12) | 00, 01, 05, 12 | Arquivo original guardado no cofre como os PDFs | Planilhas nunca executam fórmulas ou macros; CSV/OFX recebem a mesma higiene de log e disco dos PDFs | Fixtures sintéticos por layout CSV/OFX, codificações e separadores |
| 02/10/2026 | Fases 1 a 6 implementadas; instalador opcional | Pedido do usuário | 13, CLAUDE.md | Novos tipos persistidos registrados; histórico guarda só a versão anterior nas alterações | Exportações claras com aviso; backups cifrados; IA só em loopback | 186 testes automatizados, jornada offline |
| 02/10/2026 | Roadmap ampliado com as fases 7 a 11 e dívida técnica | Pedido do usuário após concluir as fases 1 a 6 | 09, 13, CLAUDE.md | Nenhum | Nenhum | Critérios de saída mensuráveis por fase |
| 02/10/2026 | Gravação incremental (opção c do `11` §5) e abertura rápida | Pedido do usuário para resolver as dívidas | 09, 11, 13 | Mesmo formato de arquivo; só muda como é gravado | Toda página é autenticada na abertura; candidato verificado antes de substituir | `test_incremental_save`, adulteração página a página |
| 02/10/2026 | Fases 7 a 10 no que não depende do Windows nem de documentos reais | Pedido do usuário | 09, 13, 14, 15, CLAUDE.md | Nenhum tipo persistido novo; preferências de bloqueio fora do cofre | Desbloqueio confere senha e revisão no worker; registro técnico só com códigos; parsers isolados por `run_parser` | 276 testes; fuzzing longo com 3000 variações |
| 02/10/2026 | Revisão da interface (princípios de desktop) | Pedido do usuário | 16, CLAUDE.md | Preferências de janela e colunas fora do cofre | Nenhum segredo novo na UI; senha segue só no worker | `test_ui_design`, capturas claro/escuro/estreito |
| 02/10/2026 | Regras de categoria editáveis, orçamento mensal, avisos ao abrir e desfazer/refazer de edições não salvas | Pedido do usuário (aprova orçamento no escopo e desfazer só do que não foi salvo) | 00, 09, 13, 16, CLAUDE.md | Novos tipos persistidos `category_rule` e `budget_line` (versões antigas do app recusam o cofre) | Desfazer remove do histórico só o que nunca chegou ao cofre; nada novo sai da memória | `test_rules`, `test_budget`, `test_alerts`, `test_undo`, `test_family_routine` |
| 02/10/2026 | Roadmap 1.3: fases 11 a 14 com funcionalidades propostas (orçamento, regras editáveis, alertas, comprovantes, desfazer, verificação de backup, fechamento do ano) | Pedido do usuário | 09, CLAUDE.md | A definir por item | A definir por item | Critérios de saída por fase |

## 6. Definição de pronto documental (versão 1.0, mantida como histórico)

O conjunto define jornadas, limites, entidades, regras de cálculo, segurança, testes e fontes. Não contém código de produto nem garante viabilidade já comprovada. A próxima etapa autorizável é implementar os gates técnicos da fase 0; este documento não inicia essa implementação.
