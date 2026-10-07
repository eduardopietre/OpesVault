# Segurança, cofre, senha e backup

Versão 1.0 • 01/10/2026. Este documento distingue requisito de produto de garantia criptográfica.

> **07/10/2026:** o cofre SQLCipher e o worker transitório descritos aqui saíram com o desktop. A segurança em vigor é a do `19` (normativo); os requisitos de produto deste documento continuam valendo.

## 1. Modelo de ameaça

O cofre deve proteger contra leitura de arquivos e backups copiados sem a senha. Deve detectar corrupção e falhas de gravação. Não promete proteção contra malware ativo, administrador do Windows, keylogger, captura de tela, inspeção de processo desbloqueado ou manipulação maliciosa feita por quem conhece a senha.

Senha compartilhada não gera isolamento entre integrantes. Histórico interno é útil para rastreabilidade, mas não é evidência inviolável contra detentores da chave.

## 2. Senha, chave e dados em memória

Senha é a entrada humana; chave é o material derivado usado para cifrar; dados são conteúdo financeiro já aberto. Remover a senha não remove automaticamente chave nem dados.

O requisito é minimizar a duração dos segredos e não mantê-los deliberadamente para uso posterior. Não é tecnicamente defensável prometer eliminação absoluta de todas as cópias em Python/Qt ou ausência de resíduos em RAM, paginação, hibernação, dumps ou VRAM. A documentação da biblioteca cryptography descreve limitações de limpeza de memória em Python [S03].

O SQLCipher cifra páginas e verifica integridade; sua documentação descreve derivação por senha e cuidados com temporários [S01]. A configuração escolhida deverá ser verificada no binário distribuído. Não criar algoritmo criptográfico próprio nem reduzir parâmetros para acelerar salvamento sem revisão.

## 3. Arquitetura de sessão proposta

Para atender à senha em cada gravação sem manter chave deliberadamente:

1. Um processo transitório de cofre apresenta a janela de senha. A interface principal não recebe a senha.
2. Na abertura, ele autentica o cofre por leitura efetiva, carrega um snapshot consistente em memória, transfere os dados por canal local privado e fecha o banco.
3. O processo termina. A interface trabalha com dados e PDFs em RAM, sem conexão persistente ao arquivo criptografado.
4. Ao salvar, um novo processo pede a senha, verifica o arquivo existente e sua revisão, recebe o snapshot editado e grava uma nova versão cifrada.
5. Após validação e commit, esse processo também termina. A aplicação registra apenas revisão, localização e estado de salvamento, sem segredo.

O snapshot inclui os anexos necessários à visualização sem pedir senha a cada PDF. Isso pode consumir muita memória; há limite operacional medido, e o aplicativo deve recusar ou dividir lotes quando necessário. Carregamento sob demanda que exigisse senha adicional seria alternativa futura, não comportamento implícito.

Processos de parsing recebem somente os documentos necessários. Prompts enviados ao Ollama podem continuar em contexto/memória do serviço externo após resposta; não prometer limpeza comprovada da VRAM. Não registrar prompts por padrão. Identificar recursos que usam IA e permitir seu desligamento.

## 4. Gravação transacional

O comando Salvar sempre solicita senha. No cofre existente, ela autentica a versão salva antes de qualquer substituição. Senha errada não é interpretada como pedido de nova senha. Criar cofre exige confirmação; trocar senha é comando separado que valida senha atual e nova senha confirmada.

A gravação produz candidato cifrado no mesmo volume, sem banco intermediário claro. Verificar integridade criptográfica, estrutura, relações, revisão, contagens e referências documentais antes do commit. Fechar conexões e consolidar arquivos auxiliares antes da substituição. Preservar última versão válida; usar substituição atômica suportada e sincronização adequada. Comportamento em interrupção elétrica, antivírus e falta de espaço deverá ser ensaiado no Windows.

O arquivo anterior permanece válido até o commit. Se a verificação falhar, não substituir. Se o resultado for incerto, localizar e verificar candidatos antes de repetir. A limpeza de temporários só remove candidatos do próprio aplicativo e nunca o último cofre válido.

Não usar a API padrão de backup de SQLite para produzir banco sem cifra inadvertidamente. O caminho específico de snapshot/exportação SQLCipher deverá ser testado com tentativa real de leitura sem chave. Não supor que uma cópia com extensão própria esteja criptografada.

## 5. Estados da sessão

| Estado | Regra |
|---|---|
| Fechado | Sem dados da família na sessão da aplicação |
| Aberto e salvo | Dados em RAM correspondem à revisão persistida |
| Aberto e alterado | Alterações em RAM; aviso permanente “Não salvo” |
| Salvando | Senha e operações criptográficas transitórias |
| Erro de salvamento | Snapshot em RAM preservado; arquivo anterior mantido |
| Encerrando | Oferecer salvar com senha, descartar ou cancelar |

Não existe autosave persistente. Pode haver lembrete configurável. Backup automático só copia revisão já salva; não recupera trabalho em RAM. Travamento pode perder todas as alterações desde o último salvamento.

O snapshot enviado para salvar é congelado e recebe revisão própria. Se a interface permitir novas edições durante a gravação, elas continuam marcadas como não salvas após o commit; alternativamente, bloquear edição por esse intervalo. Nunca marcar como salva uma alteração que não entrou no snapshot. Um bloqueio entre instâncias, sem conteúdo financeiro, deve sobreviver à substituição do arquivo principal; não depender apenas de um handle do arquivo que será trocado.

Ocultar a janela por inatividade é bloqueio visual, não purga. O fechamento seguro encerra a sessão e descarta os dados; se houver alterações, exige salvamento com senha ou descarte explícito. Suspensão do Windows não equivale a fechamento seguro. Proteção do volume pelo sistema operacional pode complementar o cofre, sem virar requisito disfarçado nem garantia de limpeza.

## 6. Higiene de dados

Não persistir texto extraído, miniaturas, cache de PDF ou valores financeiros fora do cofre. Renderizar em memória. Desativar temporários de banco em disco; confirmar configurações do fornecedor [S01–S02]. Senhas não entram em telemetria, exceções, histórico de comandos ou área de transferência gerenciada pelo app.

Logs técnicos contêm códigos de erro e identificadores opacos, sem CPF, nomes, descrições, valores ou conteúdo de PDF. Nomes de arquivos e diretórios podem revelar contexto mesmo com conteúdo cifrado; recomendar nome neutro opcional. Não apagar automaticamente PDFs de origem. Exportações claras são ações explícitas, fora da proteção do cofre.

## 7. Backup, restauração e portabilidade

Backup é cópia consistente de uma revisão salva, incluindo PDFs. Identificar revisão e data; política inicial sugerida: últimas 10 versões, configurável e sem exclusão silenciosa de backups fixados. Não sobrescrever única cópia boa. Cópia para pendrive é manual e offline.

Restaurar abre a cópia com senha, verifica formato e integridade e cria destino separado por padrão. Mostrar revisão e data antes de adotar. Nunca sobrescrever cofre atual sem confirmação concreta. Um teste de restauração em outro Windows é obrigatório antes de considerar o recurso concluído.

Trocar senha gera nova revisão cifrada após autenticação. Backups antigos continuam com senha antiga; isso deve ser comunicado. Não há recuperação de senha por servidor, e-mail ou porta dos fundos. Perda de senha pode tornar o cofre irrecuperável.

## 8. Referências

[S01] SQLCipher Design: https://www.zetetic.net/sqlcipher/design/

[S02] SQLCipher API: https://www.zetetic.net/sqlcipher/sqlcipher-api/

[S03] Cryptography — limitações: https://cryptography.io/en/latest/limitations/

Consulta em 01/10/2026, horário de São Paulo. Fluxo de snapshot e processo transitório é proposta deste projeto, não recurso de segurança certificado pelos fornecedores.
