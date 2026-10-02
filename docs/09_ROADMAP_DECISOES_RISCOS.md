# Roadmap, decisões e riscos

Versão 1.1 • 02/10/2026. As fases 0 a 6 estão implementadas (`13`); este documento passa a planejar da fase 7 em diante.

## 1. Fases e critérios de saída

### 1.1 Fases concluídas

| Fase | Entrega | Situação |
|---|---|---|
| 0 — Viabilidade | Cofre cifrado, worker transitório, medições | Concluída; gates Windows presumidos (`11` §4) |
| 1 — Fundamentos | Cofres, pessoas, contas, operações manuais e histórico | Concluída (`13` §2) |
| 2 — Documentos | Importação/revisão, layouts, conciliação, duplicatas | Concluída com layouts **sintéticos**, exceto notas de corretagem |
| 3 — Finanças | Caixa, competência, parcelas, recorrências e fechamento | Concluída |
| 4 — Investimentos essenciais | Avaliações, aportes, resgates, simulador e gráficos | Concluída; exemplos A–F automatizados |
| 5 — Carteira detalhada | Lotes, eventos, TWR/XIRR/Dietz, notas de corretagem | Concluída |
| 6 — Consolidação | Backup/restauração, senha, exportações, instalador opcional | Concluída, sem execução real no Windows |

O que falta para o produto ser confiável não é mais funcionalidade nova: é validação com o mundo real, desempenho e usabilidade do dia a dia. As próximas fases seguem essa ordem de risco.

### 1.2 Próximas fases

| Fase | Entrega | Critério para avançar | Depende de |
|---|---|---|---|
| 7 — Validação real | Gates G0–G7 no Windows; corpus privado de documentos (fora do git) com esperado conferido; layouts sintéticos ajustados; notas de terceiros copiadas | G0–G7 aprovados; cada layout prioritário marcado `validated_with_real_documents` só após conferir campos, datas, sinais, parcelas e totais em ao menos 3 documentos por versão de layout; TA-01…TA-36 rastreados como automatizado, manual ou pendente | Máquina Windows; documentos reais do usuário |
| 8 — Desempenho do salvamento e da interface | Decisão do `11` §5 implementada (proposta: gravação incremental); tabelas com modelo virtual; consultas indexadas | Com 50 mil lançamentos e 250 MiB: salvar ≤ 3 s, abrir ≤ 5 s, pico de RAM ≤ 600 MiB por processo e telas sem travar (≤ 200 ms para filtrar); medido no Windows de referência | Decisão do usuário sobre o método de gravação |
| 9 — Uso diário | Assistente de primeiro uso; edição completa de lançamentos (valor, contas, datas, rateio por integrante); filtros por período, integrante e categoria; reclassificação em lote; revisão por teclado; ajuda contextual; bloqueio visual por inatividade | Jornadas "primeiro uso" e "revisão mensal" do `01` §3 feitas por uma pessoa sem ajuda, em escala 100/150/200%, só com teclado | Fase 8 (tabelas grandes) |
| 10 — Robustez e distribuição | Fuzzing dos parsers com PDFs/CSV/OFX malformados; política de logs técnicos (só códigos); inventário de licenças e hashes; versões fixadas após G1; SBOM; acompanhamento do OpenSSL embutido no `sqlcipher3`; revisão de segurança do worker e das exportações | Nenhuma falha de parser derruba a aplicação; inventário completo; instalador opcional assinado ou documentado | Fase 7 (versões validadas) |
| 11 — Expansões | OCR local; novos layouts (Caixa, Banco do Brasil, Santander, informe de rendimentos, extratos de investimento); `.xlsx`; moedas estrangeiras com câmbio informado; tabelas fiscais por classe parametrizadas e versionadas; benchmark de modelos Ollama | Cada expansão passa pelos mesmos critérios de validação da fase 7 | Amostras reais e decisões do usuário por item |

Fases 9 e 10 podem andar em paralelo depois da 8. Expansões da fase 11 entram uma a uma, por prioridade do usuário, nunca em bloco.

### 1.3 Dívida técnica conhecida

| Item | Efeito | Fase |
|---|---|---|
| Salvar reescreve e reverifica o cofre inteiro, com o snapshot inteiro em JSON | ~21 s e ~800 MiB com 50 mil lançamentos (`13` §4) | 8 |
| Tabelas usam `QTableWidget` preenchido por completo | Lento com dezenas de milhares de linhas | 8 |
| Consultas percorrem todas as operações a cada chamada (saldos, séries mensais) | Gráficos de patrimônio custam meses × operações | 8 |
| Livro financeiro corrige só a descrição; rateio por integrante só via domínio | Correções de valor exigem estorno e novo lançamento | 9 |
| Importação roda em thread enquanto a página fica desabilitada, mas o Ctrl+S não é bloqueado nesse intervalo | Corrida rara entre salvar e importar | 9 |
| Histórico cresce sem limite (cada alteração guarda a versão anterior) | Snapshot maior com o tempo | 8 |
| Layouts de faturas e extratos são sintéticos | Podem falhar com documentos reais | 7 |

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
| Método de gravação (`11` §5): manter reescrita completa, verificar menos ou gravar só o que mudou | Define o formato interno do cofre e a meta de tempo de salvamento | Fase 8 |
| Quando rodar os gates G0–G7 e qual é a máquina Windows de referência (RAM, disco, antivírus) | Sem isso, distribuição e metas de desempenho não têm base | Fases 7, 8 e 10 |
| Bancos e produtos prioritários, com documentos reais (faturas, extratos, CSV/OFX) | Layouts sintéticos só viram suporte com amostras | Fase 7 |
| Classes de investimento que a família usa e eventos necessários | Orienta regras por classe e layouts de extratos de investimento | Fase 11 |
| Modelo Ollama local, se a IA for usada | Escolha por benchmark, não por suposição | Fase 11 |
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

## 6. Definição de pronto documental (versão 1.0, mantida como histórico)

O conjunto define jornadas, limites, entidades, regras de cálculo, segurança, testes e fontes. Não contém código de produto nem garante viabilidade já comprovada. A próxima etapa autorizável é implementar os gates técnicos da fase 0; este documento não inicia essa implementação.
