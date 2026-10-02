# Pesquisa de documentos: projetos de referência, amostras e layouts

Versão 1.1 • 02/10/2026. O Banco Inter está fora do interesse do projeto. Complementa os documentos 05 e 10. Os projetos foram clonados e os PDFs disponíveis foram abertos com `pdfplumber` em 02/10/2026. Nenhum código de terceiros foi incorporado.

## 1. Conclusão

- **Faturas e extratos bancários:** não há PDF público. Todos os projetos tratam esses arquivos como dados pessoais e os bloqueiam no `.gitignore`. O que existe é o texto extraído reproduzido em testes e descrições das particularidades de cada layout.
- **Notas de corretagem:** existem 17 PDFs reais anonimizados. Descartados os 9 do Inter, ficam **8 de interesse**: Clear (4), Rico (3) e NuInvest (1).
- **Extratos de investimento, Tesouro Direto e informe de rendimentos:** nenhum parser de PDF encontrado, só scrapers de site. Dependem de documentos do próprio usuário.

Os projetos servem para entender o formato dos documentos, não como modelo de cálculo. Quase todos usam `float` para dinheiro e assumem o ano atual quando a data vem sem ele, o que os documentos 02 e 05 proíbem.

## 2. Projetos de referência

| Projeto | Linguagem / licença | Cobertura | Aproveitamento |
|---|---|---|---|
| [banksheet](https://github.com/tio-ze-rj/banksheet) | TypeScript / MIT | Faturas: Itaú, Bradesco, Nubank, Inter, C6, Porto Seguro | **Principal referência de layout.** Um plugin por banco com `detect()`/`parse()`, README de particularidades e o texto da fatura reproduzido nos testes |
| [OpenExtrato](https://github.com/rafael-agra/OpenExtrato) | Python + pdfplumber / MIT | Extratos e faturas: Itaú, Inter, Bradesco, Mercado Pago; CSV/OFX do Inter | Expressões de linha por banco; alternativa com OCR para o Inter |
| [extrator_fatura](https://github.com/ThomazMasayuki/extrator_fatura) | Python | Faturas genéricas (BB, Itaú, Nubank) | Concilia a soma dos lançamentos com o total da fatura e reconhece créditos em três notações |
| [nubank-to-csv](https://github.com/turicas/nubank-to-csv) | Python / GPL-3.0 | Fatura Nubank | Consolida o IOF com a compra internacional. Assume o ano atual (não seguir) |
| [Invoice_Analysis](https://github.com/IsaacMartins12/Invoice_Analysis) | Python + pdfplumber | Faturas Bradesco e Nubank | Categorização e gráficos |
| [conversor-pdf-para-ofx](https://github.com/jeanvieir4/conversor-pdf-para-ofx) | — | Extratos: Sicoob, Itaú, Bradesco, Caixa, BB, Santander, Sicredi e outros | Indica quais bancos têm extrato em PDF tabular |
| [TCCIII](https://github.com/Laion459/TCCIII) | Python | Extratos de cooperativas e Caixa | Identificação de instituição por padrões de texto e checagem aritmética do saldo |
| [leitor-de-notas-de-corretagem](https://github.com/planetsLightningArrester/leitor-de-notas-de-corretagem) | TypeScript / LGPL-3.0 | Notas: Clear, Rico, NuInvest (Inter fora de interesse) | **7 PDFs de interesse**, inclusive protegidos por senha |
| [correpy](https://github.com/thiagosalvatore/correpy) | Python / Apache-2.0 | Notas no padrão SINACOR | 1 PDF; modelo com `Decimal` e as nove taxas da nota |
| [COIR](https://github.com/MarceloPCF/COIR), [SinacorPdfParser](https://github.com/davidboto/SinacorPdfParser), [py_financas](https://github.com/jfrfonseca/py_financas) | Diversos | Notas SINACOR (XP, Clear, Rico, BTG, Necton) | Cobertura de mercados (à vista, opções, futuros) |

## 3. Particularidades de layout observadas

| Instituição / documento | Particularidade | Consequência para o parser |
|---|---|---|
| Nubank — fatura | Data `DD MMM`; o ano só aparece no cabeçalho `FATURA DD MMM YYYY` | Derivar o ano do cabeçalho e tratar a virada de ano; nunca usar o relógio |
| Nubank — fatura | Compra internacional ocupa várias linhas (USD, cotação, R$); o IOF vem em linha separada | Agrupar as linhas numa operação; o IOF é um componente próprio (doc 04 §5) |
| Nubank — fatura | `−R$` indica crédito; linhas "Saldo restante" de valor zero | Sinal pelo marcador do layout; ignorar linhas informativas registrando-as como não mapeadas |
| Itaú — fatura | A seção "Próximas faturas" repete parcelas futuras | Separar parcelas futuras das cobranças atuais; risco de duplicação |
| Itaú — fatura | O IOF aparece só no resumo | Conciliar o total com o IOF do resumo |
| Itaú — fatura | Extratores JavaScript devolvem o texto sem espaços (`04/02NETFLIX.COM44,90`); parcela grudada no valor (`01/03169,90`) | Usar coordenadas do `pdfplumber`; o número da parcela nunca é valor (doc 05 §4) |
| Bradesco — fatura | Pagamento com sufixo `-` (`2.500,00-`); vários portadores com subtotal; cidade grudada na descrição | Sinal por sufixo; portador por bloco; descrição e cidade separadas por coluna |
| Notas SINACOR (Clear, Rico) | Gerados por PDFsharp; colunas C/V, mercado, prazo, título, quantidade, preço, valor e D/C; resumo com nove taxas | Estrutura comum entre corretoras do grupo XP; validar a soma de operações e taxas contra o líquido |
| Notas Rico/Clear | Alguns PDFs exigem senha (no grupo XP costuma ser formada por dígitos do CPF) | Pedir a senha só no momento, sem guardar nem registrar em log (doc 05 §3) |
| NuInvest — nota | Gerado por wkhtmltopdf; o negrito é simulado imprimindo cada caractere duas vezes (`NNuuIInnvveesstt`) | Usar `page.dedupe_chars()` antes de extrair; testado e funciona |

Cada gerador de PDF (PDFsharp, wkhtmltopdf, JasperReports, iLovePDF) produz texto e coordenadas diferentes. Isso confirma o doc 05 §1: suporte é declarado por versão de layout, e um mesmo banco pode mudar de gerador.

## 4. Amostras de terceiros

Os 17 PDFs de notas de corretagem foram auditados em 02/10/2026; só os 8 sem o Inter serão usados:
- nenhum CPF diferente de `000.000.000-00`;
- nomes e endereços removidos do texto ou trocados por marcadores ("RANDOM NAME", "CLIENTE");
- metadados contêm apenas o gerador;

As senhas de teste são `123` (`rico_single_page_pwd.pdf`) e `456` (`clear_single_page_sell_pwd.pdf`).

O usuário aprovou incluir os 8 como fixtures em `tests/fixtures/terceiros/notas_corretagem/`, com a licença e o crédito de cada projeto. A cópia **ainda não foi feita**: foi bloqueada pela política de permissões do ambiente e depende do usuário. O passo a passo, a lista de arquivos e as origens estão em `tests/fixtures/terceiros/notas_corretagem/README.md`.

## 5. Exportações estruturadas (CSV e OFX)

Vários projetos preferem o CSV ou OFX exportado pelo banco: OpenExtrato (CSV e OFX do Inter, CSV do Bradesco) e Financas-SaaS (CSV de Nubank, Itaú, Inter, Bradesco e BB). Como esses formatos são mais confiáveis que o texto de PDF, o escopo foi ampliado em 02/10/2026 para aceitá-los. As regras estão no doc 05 §1 e §3, e o registro no doc 09 §5.

## 6. Lacunas

- Nenhuma amostra pública de fatura, extrato de conta ou extrato de investimento: os fixtures serão sintéticos, imitando cada layout, complementados por documentos reais do usuário guardados fora do git.
- Informe de rendimentos e extratos de investimento (CDB, fundos, Tesouro Direto) não têm parser público; precisam de amostras do usuário.
- Exportações estruturadas não têm amostras públicas confiáveis; os formatos de CSV de cada banco devem ser confirmados com arquivos reais.
