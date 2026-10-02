# Referências e pesquisa de componentes

Versão 1.0 • Pesquisa consultada em 01/10/2026, horário de São Paulo.

Fontes primárias consultadas para planejamento. A documentação pública não substitui execução de testes com arquivos e ambiente reais. Não foram baixados documentos financeiros pessoais de terceiros nem executados os projetos citados.

## 1. Extração de documentos

| Fonte | Achado | Decisão para o projeto |
|---|---|---|
| [banksheet](https://github.com/tio-ze-rj/banksheet) | Projeto TypeScript local; declara faturas Bradesco, Itaú, Nubank, Inter, C6 e Porto Seguro; licença MIT | Candidato para estudar e adaptar regras; não prova cobertura de extratos ou investimentos |
| [Contribuição banksheet](https://github.com/tio-ze-rj/banksheet/blob/main/CONTRIBUTING.md) | Orientações para extensão do projeto | Consultar junto ao código e testes antes de reaproveitar |
| [OpenExtrato](https://github.com/rafael-agra/OpenExtrato) | Python/pdfplumber; declara extrato Itaú PDF e cartão Inter PDF, além de CSVs; licença MIT | Referência pontual; revisar dependências de rede antes de qualquer reaproveitamento |
| [pdfplumber](https://github.com/jsvine/pdfplumber) | Extração de texto, geometria e tabelas de PDFs digitais | Biblioteca principal proposta |
| [pypdfium2](https://github.com/pypdfium2-team/pypdfium2) | Binding Python para PDFium | Renderização local proposta; inventariar licenças transitivas |
| [Portfolio Performance: PDF](https://help.portfolio-performance.info/en/reference/file/import/pdf-import/) | Importação por parsers específicos de instituições | Referência de fluxo e cobertura por documento |

Não foi confirmado um corpus público anonimizado suficiente para Itaú, Bradesco, Nubank e Caixa. Não se deve afirmar suporte à Caixa com base no suporte a outros bancos. Para cada layout, solicitar documentos autorizados ou produzir exemplos sintéticos complementados por validação real.

O suporte declarado pelos projetos é informação dos autores, não verificação independente desta pesquisa. As licenças permissivas identificadas não eliminam a necessidade de manter avisos e analisar dependências de cada trecho incorporado.

## 2. Cofre e distribuição

| Fonte | Uso na decisão |
|---|---|
| [SQLCipher Design](https://www.zetetic.net/sqlcipher/design/) | Fundamentos do banco cifrado, integridade e temporários |
| [SQLCipher API](https://www.zetetic.net/sqlcipher/sqlcipher-api/) | Configuração, troca de chave, exportação e verificações |
| [sqlcipher3](https://github.com/coleifer/sqlcipher3) | Binding Python candidato; ensaio Windows obrigatório |
| [Qt: pyside6-deploy](https://doc.qt.io/qtforpython-6/deployment/deployment-pyside6-deploy.html) | Caminho de distribuição baseado em Nuitka |
| [Cryptography: limitações](https://cryptography.io/en/latest/limitations/) | Fundamenta limites de alegações sobre limpeza de memória em Python |

O processo transitório e o snapshot em memória são desenho proposto deste projeto. Não representam certificação, funcionalidade pronta de SQLCipher ou garantia de resistência a malware local. Bibliotecas exatas e builds serão definidos pela fase de viabilidade.

## 3. IA local

| Fonte | Uso |
|---|---|
| [Ollama FAQ](https://docs.ollama.com/faq) | Modo local, desativação de cloud e configuração de escuta |
| [Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs) | Saídas estruturadas para validação |

Não escolher modelo apenas pela existência de CUDA. O benchmark deve medir extração assistida, classificação, memória e latência. Saída estruturalmente válida continua sujeita a erro factual.

## 4. Métodos de investimentos

| Fonte | Uso |
|---|---|
| [Portfolio Performance: TWR](https://help.portfolio-performance.info/en/concepts/performance/time-weighted/) | Referência conceitual de retorno ponderado pelo tempo |
| [Portfolio Performance: MWR](https://help.portfolio-performance.info/en/concepts/performance/money-weighted/) | Referência conceitual de retorno ponderado pelos fluxos |

Regras de arredondamento, exemplos e tratamento de dados faltantes são especificações do aplicativo. Nenhuma tabela tributária brasileira foi validada nesta etapa. Os percentuais ilustrativos não devem se tornar defaults legais.

## 5. O que ainda precisa de investigação técnica

Qualidade real dos parsers com diferentes produtos bancários; acesso e licenciamento de amostras; compatibilidade do binding SQLCipher com empacotamento escolhido; pico de RAM do snapshot; integridade de salvamento em Windows; licenças de distribuição Qt/PDFium e dependências; desempenho dos modelos já instalados; regras por classe de investimento quando houver demanda fiscal específica.

Essas lacunas estão explicitadas no roadmap e nos gates. Nenhuma delas foi preenchida com promessa de “parsing perfeito” ou “criptografia sem resíduos”.
