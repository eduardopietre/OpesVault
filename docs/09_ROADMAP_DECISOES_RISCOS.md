# Roadmap, decisões e riscos

Versão 1.0 • 01/10/2026.

## 1. Fases e critérios de saída

| Fase | Entrega | Critério para avançar |
|---|---|---|
| 0 — Viabilidade | Executável Windows experimental, cofre e sessão transitória | SQLCipher/Qt/PDFium empacotados; salvar/restaurar; RAM medida; nenhuma persistência clara |
| 1 — Fundamentos | Cofres, pessoas, contas, operações manuais e histórico | Invariantes contábeis e recuperação aprovados |
| 2 — Documentos | Importação/revisão, primeiros layouts e conciliação | Casos autorizados e fixtures conferidos; sem duplicação |
| 3 — Finanças | Caixa, competência, parcelas, recorrências e fechamento | Fatura, transferência e previsão conciliadas corretamente |
| 4 — Investimentos essenciais | Avaliações manuais, aportes, resgates e gráficos | Exemplos A–F e impostos informados/simulados aprovados |
| 5 — Carteira detalhada | Quantidades, custos/lotes, eventos e métodos de retorno | Regras por classe validadas e lacunas apresentadas |
| 6 — Consolidação | Usabilidade, exportações, distribuição e cobertura ampliada | Restauração offline em outra máquina e jornadas completas |

Não há prazo estimado sem medir esforço de layouts reais. Gráficos e avaliações manuais entram na fase 4 mesmo que a importação de investimentos ainda não cubra determinada instituição.

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

## 4. Pendências que não bloqueiam estes documentos

- Ícone do aplicativo (nome OpesVault e extensão `.opesvault` já decididos).
- Ordem exata dos bancos/produtos prioritários, conforme amostras reais.
- Classes de investimento usadas pela família e eventos necessários.
- Máquina Windows de referência, RAM, GPU e VRAM para dimensionamento.
- Versões fixas das dependências após ensaio.
- Limite operacional de tamanho do cofre e volume documental.
- Modelo Ollama local e tamanho adequado; seleção por benchmark, não por suposição.
- Inclusão futura de OCR, moedas estrangeiras completas e regras fiscais por classe.

## 5. Controle de mudanças

Cada alteração de escopo registra motivo, documentos afetados, migração de dados, impacto de segurança e testes necessários. Propostas que introduzam cloud, retenção de chave para autosave, edição simultânea ou mudança de stack exigem nova decisão do usuário. Ajustes rotineiros de implementação dentro da arquitetura não exigem reaprovação de cada biblioteca auxiliar.

## 6. Definição de pronto documental

O conjunto define jornadas, limites, entidades, regras de cálculo, segurança, testes e fontes. Não contém código de produto nem garante viabilidade já comprovada. A próxima etapa autorizável é implementar os gates técnicos da fase 0; este documento não inicia essa implementação.
