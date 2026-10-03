"""Synthetic documents imitating each supported layout (docs/05 §8, docs/12 §3).

All names and values are fictitious.
"""

from opesvault.devtools.synthetic_pdf import make_pdf, make_pdf_pages


def nubank_card_pdf(previous: str = "500,00", total: str = "1.050,30") -> bytes:
    return make_pdf(
        [
            "Nu Pagamentos S.A. - CNPJ 18.236.120/0001-58",
            "FATURA 10 JAN 2026",
            f"Saldo anterior R$ {previous}",
            f"Total a pagar R$ {total}",
            "TRANSAÇÕES DE 03 DEZ A 03 JAN",
            "05 DEZ Mercado Bom Preço R$ 100,00",
            "05 DEZ Mercado Bom Preço R$ 100,00",
            "12 DEZ Pagamento recebido -R$ 500,00",
            "20 DEZ Loja Eletro - Parcela 1/3 R$ 300,00",
            "28 DEZ Amazon.com USD 20,00",
            "Conversão: USD 1 = R$ 5,20",
            "R$ 104,00",
            '28 DEZ IOF de "Amazon.com" R$ 3,64',
            "02 JAN Estorno Loja Eletro -R$ 57,34",
            "02 JAN Saldo restante R$ 0,00",
            "02 JAN Padaria R$ 500,00",
        ]
    )


def itau_card_pdf() -> bytes:
    return make_pdf_pages(
        [
            [
                "Banco Itaú S.A. - ITAÚ UNIBANCO HOLDING",
                "Vencimento: 10/02/2026  Fechamento: 03/02/2026",
                "Fatura anterior 1.000,00",
                "Total desta fatura R$ 694,80",
                "Lançamentos no cartão (final 1234)",
                "04/01 NETFLIX.COM 44,90",
                "09/01 PROQUALITY 01/03 169,90",
                "28/12 LOJAS RENNER 02/03 171,70",
                "02/01 PAGAMENTO EFETUADO -1.000,00",
                "Lançamentos no cartão (final 5678)",
                "15/01 POSTO SHELL 278,30",
                "Repasse de IOF em R$ 30,00",
            ],
            [
                "Compras parceladas - próximas faturas",
                "09/01 PROQUALITY 02/03 169,90",
                "28/12 LOJAS RENNER 03/03 171,70",
                "Limite total de crédito 10.000,00",
            ],
        ]
    )


def bradesco_card_pdf() -> bytes:
    return make_pdf(
        [
            "Bradesco Cartões - Banco Bradesco S/A",
            "Vencimento 15/03/2026",
            "Total da fatura R$ 640,00",
            "ANA SILVA - Cartão final 4321",
            "02/02 SUPERMERCADO X SAO PAULO 200,00",
            "10/02 PAGTO. POR DEB EM C/C 500,00-",
            "Total para ANA SILVA 200,00",
            "BRUNO SILVA - Cartão final 8765",
            "11/02 LIVRARIA CENTRAL 03/10 40,00",
            "20/02 FARMACIA POPULAR 400,00",
            "Total para BRUNO SILVA 440,00",
            "Saldo anterior 500,00",
        ]
    )


def itau_bank_pdf(closing: str = "1.320,00") -> bytes:
    return make_pdf(
        [
            "Itaú Unibanco - Extrato de conta corrente",
            "Agência 1234 Conta 56789-0",
            "Período: 01/01/2026 a 31/01/2026",
            "SALDO ANTERIOR 1.000,00",
            "05/01/2026 SALARIO EMPRESA X 5.000,00",
            "05/01/2026 SALDO DO DIA 6.000,00",
            "10/01/2026 PIX ENVIADO ALUGUEL -2.500,00",
            "15/01/2026 TED POUPANCA PROPRIA -500,00",
            "20/01/2026 PAGAMENTO FATURA CARTAO -1.680,00",
            f"31/01/2026 SALDO FINAL {closing}",
        ]
    )


def nubank_account_csv() -> bytes:
    return (
        "Data,Valor,Identificador,Descrição\n"
        "01/02/2026,1500.00,a1b2-01,Transferência recebida - EMPRESA Y\n"
        "03/02/2026,-89.90,a1b2-02,Compra no débito - FARMACIA SAO JOAO\n"
        "03/02/2026,-89.90,a1b2-03,Compra no débito - FARMACIA SAO JOAO\n"
    ).encode()


def nubank_card_csv() -> bytes:
    return (
        b"date,title,amount\n"
        b"2026-02-03,Uber *Trip,23.45\n"
        b"2026-02-04,Loja Z - Parcela 2/5,60.00\n"
        b"2026-02-05,Pagamento recebido,-300.00\n"
    )


def ofx_bank(fitid_prefix: str = "F") -> bytes:
    return f"""OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:USASCII
CHARSET:1252

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>BRL
<BANKACCTFROM><BANKID>0341<ACCTID>567890</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260101
<DTEND>20260131
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260105120000[-3:BRT]
<TRNAMT>5000.00
<FITID>{fitid_prefix}001
<MEMO>SALARIO EMPRESA X
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260110
<TRNAMT>-2500.00
<FITID>{fitid_prefix}002
<MEMO>PIX ALUGUEL
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>3500.00<DTASOF>20260131</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
""".encode("cp1252")


def sinacor_note_pdf() -> bytes:
    """Same structure as the public anonymized SINACOR notes (two-column summary)."""
    return make_pdf(
        [
            "NOTA DE NEGOCIAÇÃO",
            "Nr. nota Folha Data pregão",
            "123456 1 02/03/2026",
            "CORRETORA FICTICIA - CLEAR",
            "Negócios realizados",
            "Q Negociação C/V Tipo mercado Prazo Especificação do título Obs. (*) Quantidade Preço / Ajuste"
            " Valor Operação / Ajuste D/C",
            "1-BOVESPA C VISTA PETROBRAS PN N2 PETR4 100 30,00 3.000,00 D",
            "1-BOVESPA C FRACIONARIO ITAUSA PN N1 ITSA4 # 10 10,50 105,00 D",
            "1-BOVESPA V VISTA VALE ON NM VALE3 50 60,00 3.000,00 C",
            "Resumo dos Negócios Resumo Financeiro",
            "Vendas à vista 3.000,00 Valor líquido das operações 105,00 D",
            "Compras à vista 3.105,00 Taxa de liquidação 1,65 D",
            "Opções - compras 0,00 Taxa de Registro 0,00 D",
            "Emolumentos 0,30 D",
            "Taxa Operacional 0,00 D",
            "Execução 0,00",
            "Taxa de Custódia 0,00",
            "Impostos 0,00",
            "I.R.R.F. s/ operações, base R$3.000,00 0,15",
            "Outros 0,00 C",
            "Líquido para 04/03/2026 106,95 D",
        ]
    )


def bank_income_report_pdf(year: int = 2025) -> bytes:
    """Informe de rendimentos of a bank (generic layout; fictitious values)."""
    return make_pdf(
        [
            "Banco Exemplo S.A. - CNPJ 11.222.333/0001-81",
            "INFORME DE RENDIMENTOS FINANCEIROS",
            f"Ano-calendário: {year}",
            "Cliente: Ana Teste - CPF 529.982.247-25",
            "1. Saldos",
            f"Conta corrente - saldo em 31/12/{year - 1} R$ 1.000,00",
            f"Conta corrente - saldo em 31/12/{year} R$ 2.500,00",
            "2. Rendimentos isentos e não tributáveis",
            "Rendimento de poupança 12,34",
            "3. Rendimentos sujeitos à tributação exclusiva",
            "Aplicações de renda fixa 45,60",
            "Imposto de renda retido na fonte 10,26",
            "Atendimento 0800 000 0000",
        ]
    )
