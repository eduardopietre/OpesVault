# Rastreabilidade dos testes de aceitação

Versão 1.0 • 02/10/2026. Liga cada teste de aceitação do `08` aos testes automatizados que o verificam e diz o que falta. É o critério de saída da fase 7 (`09` §1.2): todo TA marcado como automatizado, manual ou pendente.

**Situação:** automatizado (roda no `pytest` em qualquer sistema); parcial (parte do resultado esperado ainda não é verificada); Windows (precisa de execução manual numa máquina Windows, `11` §4); pendente (sem teste).

Os caminhos são relativos a `tests/`.

| TA | Situação | Testes | O que falta |
|---|---|---|---|
| TA-01 | automatizado | `test_journey::test_family_journey`, `test_store::test_create_save_load_roundtrip`, `test_worker::test_client_through_real_subprocess` | Diálogo real de senha só em `test_password_dialog` |
| TA-02 | automatizado | `test_acceptance_gaps::test_ta02_wrong_password_keeps_file_and_ram`, `test_store::test_wrong_password_on_load_and_save_changes_nothing` | — |
| TA-03 | automatizado | `test_acceptance_gaps::test_ta03_cancel_on_existing_vault_writes_nothing`, `test_worker::test_cancel_writes_nothing` | — |
| TA-04 | automatizado + Windows | `test_acceptance_gaps::test_ta04_worker_process_is_gone_after_each_operation` | Inspeção de memória do processo com ferramenta do Windows (G5) |
| TA-05 | automatizado | `test_store::test_vault_bytes_are_encrypted`, `test_misc::test_pdf_render_and_extract_in_memory_without_temp_files`, `test_diagnostics::test_record_keeps_only_codes_and_locations` | Varredura de `%TEMP%` no Windows durante uma sessão completa (G5) |
| TA-06 | automatizado | `test_crash_recovery::test_killed_save_keeps_a_valid_vault`, `test_incremental_save::test_killed_incremental_save_keeps_a_valid_vault` | Queda de energia real só no roteiro G3 |
| TA-07 | parcial + Windows | `test_backup::test_backup_is_encrypted_copy_and_restores_ta07`, `test_journey::test_family_journey` | Outro computador simulado por outra pasta; restauração real em outro Windows é manual |
| TA-08 | automatizado + Windows | `test_misc::test_second_editor_is_locked_out`, `test_windows::test_lock_blocks_another_process` | Bloqueio entre processos só roda no Windows |
| TA-09 | automatizado | `test_store::test_externally_replaced_vault_is_detected`, `test_store::test_replacement_during_write_is_detected` | — |
| TA-10 | parcial | `test_importing::test_nubank_card_quirks`, `test_importing::test_itau_card_skips_future_installments_and_reads_iof`, `test_fixtures_terceiros::test_sinacor_parser_reconciles_public_notes` | Layouts sintéticos; conferência com documentos reais pelo `scripts/validar_layouts.py` (§2) |
| TA-11 | automatizado | `test_importing::test_scanned_pdf_is_unsupported`, `test_importing::test_unknown_layout_and_scanned_are_kept_as_pending`, `test_fuzz::*` | — |
| TA-12 | automatizado | `test_importing::test_reimport_same_file_is_refused_ta12` | — |
| TA-13 | automatizado | `test_importing::test_overlapping_statements_link_evidence_ta13` | — |
| TA-14 | automatizado | `test_importing::test_two_equal_legit_purchases_are_kept_ta14`, `test_daily_use::test_review_keyboard_flow` | — |
| TA-15 | automatizado | `test_domain_ledger::test_card_purchase_and_bill_payment_ta15` | — |
| TA-16 | automatizado | `test_domain_ledger::test_own_transfer_ta16` | — |
| TA-17 | automatizado | `test_finance::test_realized_salary_is_linked_and_not_counted_twice_ta17` | — |
| TA-18 | parcial | `test_domain_ledger::test_joint_account_counts_once_ta18`, `test_domain_ledger::test_rateio_by_member` | Comparação explícita entre visão por integrante e consolidada |
| TA-19 | automatizado | `test_finance::test_closed_month_blocks_changes_until_reopened_ta19`, `test_edits::test_reclassify_respects_closed_months_and_needs_reason` | — |
| TA-20 a TA-23 | automatizado | `test_investments::test_example_a…d_*` | — |
| TA-24 | parcial | `test_investments::test_example_e_external_distribution_ta24` | Mudança de perímetro (posição entrando ou saindo de uma visão) |
| TA-25 | automatizado | `test_investments::test_example_f_unknown_cost_ta25` | — |
| TA-26 | automatizado | `test_investments::test_disagreeing_sources_same_date_ta26` | — |
| TA-27 | automatizado | `test_portfolio::test_twr_unavailable_without_valuation_at_flow_ta27` | — |
| TA-28 | automatizado | `test_investments::test_tax_due_later_reduces_cash_only_when_paid_ta28` | — |
| TA-29 | parcial | `test_ai::test_offline_is_unavailable`, `test_ai::test_invalid_json_is_unavailable`, `test_journey::test_family_journey` | Revisão manual e salvamento com a IA ligada e falhando |
| TA-30 | parcial | `test_journey::test_family_journey` (rede externa bloqueada) | Renderizar todas as telas com a rede bloqueada |
| TA-31 | automatizado | `test_acceptance_gaps::test_ta31_switching_family_shows_nothing_from_the_previous` | — |
| TA-32 | automatizado | `test_domain_ledger::test_allocate_is_exact`, `test_domain_ledger::test_rounding_is_half_away_from_zero` | — |
| TA-33 | automatizado | `test_acceptance_gaps::test_ta33_migrated_vault_is_backed_up_before_any_write`, `test_store::test_newer_format_is_refused` | — |
| TA-34 | automatizado | `test_acceptance_gaps::test_ta34_export_is_explicit_and_leaves_the_vault_alone`, `test_exports::*` | — |
| TA-35 | automatizado | `test_acceptance_gaps::test_ta35_approved_but_unsaved_work_is_not_masked` | — |
| TA-36 | parcial | `test_investments::test_composition_partial_without_price_ta36` | Moeda sem câmbio depende de moedas estrangeiras (fase 11) |

Resumo: 29 automatizados (TA-04, TA-05 e TA-08 com complemento manual no Windows), 7 parciais (TA-07 também depende do Windows) e nenhum pendente.

## 2. Validação dos layouts com documentos reais

O `08` §7 exige documentos autorizados antes de declarar um layout suportado. O roteiro:

1. Junte os documentos numa pasta **fora do repositório**, de preferência num volume cifrado (BitLocker). As pastas `corpus/`, `amostras_privadas/` e `private/` e os arquivos `*.esperado.json` já estão no `.gitignore`.
2. Gere rascunhos: `uv run python scripts/validar_layouts.py PASTA --gerar-esperado`. Cada documento ganha um `X.esperado.json` com `"conferido": false`.
3. Confira cada rascunho contra o documento original, corrija o que estiver errado e marque `"conferido": true`. O rascunho mostra o que o parser leu, não o que é correto.
4. Rode `uv run python scripts/validar_layouts.py PASTA`. O relatório lista só nomes de campos e posições de itens; `--detalhes` mostra os valores divergentes e não deve ser compartilhado.
5. Com 3 documentos conferidos e sem divergência na mesma versão de layout, o relatório indica que o layout está pronto. Só então `validated_with_real_documents` passa a `True` no parser.

A detecção faz parte da validação: um documento detectado como outro layout, ou de forma ambígua, conta como divergência.
