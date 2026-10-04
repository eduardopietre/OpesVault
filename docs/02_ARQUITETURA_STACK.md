# Arquitetura e stack

Versão 1.0 • 01/10/2026.

## 1. Forma do aplicativo

Monólito desktop modular em Python com interface PySide6/Qt Widgets. Não há servidor web próprio nem necessidade de navegador. Os módulos mantêm fronteiras internas claras; as operações sensíveis de cofre e o processamento pesado podem executar em processos auxiliares.

O arquivo persistente é SQLCipher. A sessão editável é mantida em memória e só é gravada mediante senha. Essa escolha atende ao pedido de não reter deliberadamente uma chave do cofre durante toda a sessão, com custo de memória e risco de perda das alterações não salvas. Detalhamento normativo no documento 03.

## 2. Componentes

| Componente | Responsabilidade | Não deve fazer |
|---|---|---|
| Interface Qt | Navegação, tabelas, revisão e comandos do usuário | Cálculo financeiro independente do domínio |
| Serviço de sessão | Cofre ativo, alterações, estados e consultas em memória | Guardar senha para salvar depois |
| Serviço de cofre | Abertura, gravação, migração e verificação em processo transitório | Manter conexão SQLCipher aberta após a operação |
| Importação | Identificação, extração, normalização e evidências | Aprovar resultados automaticamente |
| Conciliação | Saldos, faturas, transferências e duplicatas | Criar ajustes de equilíbrio invisíveis |
| Domínio financeiro | Registros, partidas, competência e previsões | Depender de interface ou modelo de IA |
| Investimentos | Posições, custos, avaliações, resgates e retornos | Inventar cotações ou regras fiscais |
| Relatórios | Agregações e conjuntos de dados de gráficos | Somar moedas distintas sem conversão explícita |
| Adaptador Ollama | Sugestões estruturadas locais; no Assistente, pedir as ferramentas do próprio aplicativo (decisão do usuário de 04/10/2026, `05` §5) | Executar instruções vindas de PDFs, acessar ferramentas de fora do aplicativo (busca, arquivos, rede) ou mudar dados sem a aprovação do usuário |

## 3. Tecnologias aprovadas e função

Python concentra o domínio; PySide6/Qt Widgets constrói telas e modelos de tabela; pdfplumber fornece texto e geometria; pypdfium2 renderiza páginas; Pydantic valida fronteiras; Decimal opera números exatos; Matplotlib desenha gráficos; SQLCipher via sqlcipher3 persiste o cofre; Ollama produz sugestões locais; pyside6-deploy/Nuitka empacota o aplicativo. pytest compõe a suíte futura.

Versões específicas serão fixadas após ensaio conjunto no Windows. Nenhuma expressão “versão mais recente” deve entrar no contrato de distribuição. Registrar versões do Python, Qt, PDFium, SQLCipher, binding e dependências transitivas, com inventário de licenças e hashes dos artefatos de distribuição.

## 4. Contratos internos, sem definição de código

| Entrada/saída | Conteúdo mínimo |
|---|---|
| Documento recebido | Bytes, nome original, resumo criptográfico, tamanho e origem |
| Extração | Instituição, layout, versão do parser, campos, transações, evidências e avisos |
| Item revisado | Original, correção, responsável declarado, instante e justificativa |
| Comando financeiro | Intenção, valores exatos, moeda, datas, vínculos e origem |
| Resultado de cálculo | Valor, unidade, período, método, premissas, qualidade e versão |
| Dados de gráfico | Série, datas, valores, moeda, proveniência e pontos sem informação |
| Snapshot de sessão | Revisão-base, entidades, documentos, histórico e alterações consistentes |

Toda comunicação com processo auxiliar deve ocorrer por canal local privado, sem argumentos de linha de comando contendo segredos. Dados recebidos são validados antes de utilização. Processos não podem herdar handles desnecessários. Um subprocesso não é automaticamente uma sandbox.

## 5. Concorrência e cancelamento

A thread visual não extrai documentos nem executa modelos. Uma fila limita trabalhos simultâneos para evitar esgotamento de RAM e VRAM. Cancelamento de extração preserva documentos já revisados. Cancelamento de gravação só é aceito antes do ponto de commit; depois dele, informar conclusão ou resultado incerto e verificar o arquivo antes de permitir nova tentativa.

Uma família por sessão ativa. Encerrar sessão e processos associados antes de trocar de cofre. Não compartilhar caches de documentos, prompts, categorias personalizadas ou consultas entre cofres.

## 6. Precisão e armazenamento

Moeda fiduciária usa unidades mínimas inteiras quando cabível. Quantidades, preços unitários e taxas usam representação decimal exata com escala explícita, nunca coluna REAL como fonte financeira autoritativa. Entradas decimais não passam por float antes de Decimal. Gráficos podem receber aproximações de apresentação, sem realimentar cálculos.

Datas financeiras são datas locais; eventos técnicos usam instantes com fuso explícito. Separar data de registro, ocorrência, competência, vencimento, liquidação e avaliação. Identificadores internos são estáveis e independentes da ordem de importação.

## 7. Distribuição e operação offline

Instalador com componentes necessários, sem downloads silenciosos no primeiro uso. Ollama e modelos são pré-requisitos opcionais separados; ausência deles desativa apenas a assistência. Nenhum logotipo, fonte, gráfico ou ajuda depende de CDN.

Somente o adaptador Ollama usa a interface local de rede; negar modelos cloud, URLs remotas e ferramentas de busca. As ferramentas do Assistente são do próprio aplicativo, sem servidor MCP nem porta aberta: nenhum outro programa alcança o cofre por elas. A aplicação não modifica a instalação global do Ollama sem consentimento. Verificar modo local e testar bloqueio de tráfego externo no ambiente de validação.

## 8. Gates técnicos

Antes do desenvolvimento completo: abrir e salvar SQLCipher no executável Windows; validar modo temporário em memória; comprovar ausência de fallback para SQLite sem cifra; ensaiar recuperação após interrupção; medir snapshots com PDFs; empacotar Qt e PDFium; renderizar documentos sem arquivo claro temporário. Falha nesses gates demanda revisão do detalhe arquitetural, não redução silenciosa dos requisitos de segurança.
