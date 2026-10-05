/**
 * Codes of the IRPF program (Receita Federal): Bens e Direitos groups and codes, and the codes of
 * exempt and exclusively taxed income used for investments. Port of `catalogs/irpf.py`.
 *
 * Transcribed from the layout in use since the 2022 return, checked on 03/10/2026 against public
 * guides of the 2025 and 2026 returns (Receita Federal, CRC-SP, B3, banks). The IRPF program of the
 * year is the reference: if it changes a code, update this table and its test (and the desktop's).
 *
 * Maps, not objects: keys like "12" and "99" would be reordered by a plain object.
 */

export const REFERENCE = "Tabelas do programa IRPF (layout desde a declaração de 2022), conferidas em 03/10/2026";

/** group -> (group name, {code: description}) */
export const ASSET_CODES: ReadonlyMap<string, readonly [name: string, codes: ReadonlyMap<string, string>]> = new Map<
  string,
  readonly [string, ReadonlyMap<string, string>]
>([
  [
    "01",
    [
      "Bens imóveis",
      new Map<string, string>([
        ["01", "Prédio residencial"],
        ["02", "Prédio comercial"],
        ["03", "Galpão"],
        ["11", "Apartamento"],
        ["12", "Casa"],
        ["13", "Terreno"],
        ["14", "Terra nua"],
        ["15", "Sala ou conjunto"],
        ["16", "Construção"],
        ["17", "Benfeitorias"],
        ["18", "Loja"],
        ["99", "Outros bens imóveis"],
      ]),
    ],
  ],
  [
    "02",
    [
      "Bens móveis",
      new Map<string, string>([
        ["01", "Veículo automotor terrestre: caminhão, automóvel, moto etc."],
        ["02", "Aeronave"],
        ["03", "Embarcação"],
        ["04", "Bem relacionado com o exercício da atividade autônoma"],
        ["05", "Quadro, objeto de arte, de coleção, antiguidade etc."],
        ["06", "Joia"],
        ["99", "Outros bens móveis"],
      ]),
    ],
  ],
  [
    "03",
    [
      "Participações societárias",
      new Map<string, string>([
        ["01", "Ações (inclusive as listadas em bolsa)"],
        ["02", "Quotas ou quinhões de capital"],
        ["99", "Outras participações societárias"],
      ]),
    ],
  ],
  [
    "04",
    [
      "Aplicações e investimentos",
      new Map<string, string>([
        ["01", "Depósito em conta poupança"],
        ["02", "Títulos públicos e privados sujeitos à tributação (Tesouro Direto, CDB, RDB e outros)"],
        ["03", "Títulos isentos de tributação (LCI, LCA, CRI, CRA, LIG, debêntures de infraestrutura e outros)"],
        ["04", "Ativos negociados em bolsa no Brasil (BDR, opções e outros, exceto ações e fundos)"],
        ["05", "Ouro, ativo financeiro"],
        ["99", "Outras aplicações e investimentos"],
      ]),
    ],
  ],
  [
    "05",
    [
      "Créditos",
      new Map<string, string>([
        ["01", "Empréstimos concedidos"],
        ["02", "Crédito decorrente de alienação"],
        ["99", "Outros créditos"],
      ]),
    ],
  ],
  [
    "06",
    [
      "Depósitos à vista e numerário",
      new Map<string, string>([
        ["01", "Depósito em conta corrente ou conta pagamento"],
        ["10", "Dinheiro em espécie — moeda nacional"],
        ["11", "Dinheiro em espécie — moeda estrangeira"],
        ["99", "Outros depósitos à vista"],
      ]),
    ],
  ],
  [
    "07",
    [
      "Fundos",
      new Map<string, string>([
        ["01", "Fundos de investimento sujeitos à tributação periódica (come-cotas)"],
        ["02", "Fundos de investimento nas cadeias produtivas agroindustriais (Fiagro)"],
        ["03", "Fundos de investimento imobiliário (FII)"],
        ["04", "Fundos de investimento em ações e fundos mútuos de privatização — FGTS"],
        ["05", "Fundos de investimento em ações — mercado de acesso"],
        ["06", "Fundos de investimento em participações (FIP), em cotas de FIP e em empresas emergentes"],
        ["07", "FIP em infraestrutura (FIP-IE) e em produção econômica intensiva em PD&I (FIP-PD&I)"],
        ["08", "Fundos de índice de renda fixa"],
        ["09", "Demais fundos de índice de mercado (ETF)"],
        ["10", "Fundos de investimento em direitos creditórios (FIDC)"],
        ["11", "Fundos de investimento sem tributação periódica"],
        ["99", "Outros fundos"],
      ]),
    ],
  ],
  [
    "08",
    [
      "Criptoativos",
      new Map<string, string>([
        ["01", "Bitcoin (BTC)"],
        ["02", "Outras criptomoedas (altcoins: ETH, XRP, BCH, LTC etc.)"],
        ["03", "Stablecoins (USDT, USDC, BRZ etc.)"],
        ["10", "NFT (non-fungible tokens)"],
        ["99", "Outros criptoativos"],
      ]),
    ],
  ],
  [
    "99",
    [
      "Outros bens e direitos",
      new Map<string, string>([
        ["01", "Licença e concessão especiais"],
        ["02", "Título de clube e assemelhado"],
        ["03", "Direito de autor, de inventor e patente"],
        ["04", "Direito de lavra e assemelhado"],
        ["05", "Consórcio não contemplado"],
        ["06", "VGBL — Vida Gerador de Benefício Livre"],
        ["07", "Juros sobre capital próprio creditados, mas não pagos"],
        ["99", "Outros bens e direitos"],
      ]),
    ],
  ],
]);

/** Rendimentos isentos e não tributáveis: the codes an investment's income usually goes to. */
export const EXEMPT_CODES: ReadonlyMap<string, string> = new Map<string, string>([
  ["09", "Lucros e dividendos recebidos"],
  ["12", "Rendimentos de caderneta de poupança, letras hipotecárias, LCI, LCA, CRI e CRA"],
  ["20", "Ganhos líquidos em operações no mercado à vista de ações até R$ 20.000,00 por mês"],
  ["26", "Outros (ex.: rendimentos de fundos imobiliários)"],
]);

/** Rendimentos sujeitos à tributação exclusiva/definitiva. */
export const EXCLUSIVE_CODES: ReadonlyMap<string, string> = new Map<string, string>([
  ["01", "13º salário"],
  ["06", "Rendimentos de aplicações financeiras"],
  ["10", "Juros sobre capital próprio"],
  ["11", "Participação nos lucros ou resultados (PLR)"],
  ["12", "Outros"],
]);

/** Bens e Direitos of the parts of a bank account. */
export const CHECKING = ["06", "01"] as const;
export const SAVINGS = ["04", "01"] as const;

export const GROUPS: ReadonlyMap<string, string> = new Map([...ASSET_CODES].map(([group, [name]]) => [group, name]));

export function assetLabel(group: string | null, code: string | null): string {
  const entry = group ? ASSET_CODES.get(group) : undefined;
  if (!group || entry === undefined) return "a definir";
  const [name, codes] = entry;
  if (!code) return `${group} — ${name}`;
  return `${group}.${code} — ${codes.get(code) ?? "código desconhecido"}`;
}

export function isAssetCode(group: string, code: string): boolean {
  return ASSET_CODES.get(group)?.[1].has(code) ?? false;
}

/** (group, code, description) of the groups an investment can be in. */
export function investmentCodes(): [group: string, code: string, description: string][] {
  const out: [string, string, string][] = [];
  for (const group of ["04", "07", "03", "08", "99"]) {
    for (const [code, description] of ASSET_CODES.get(group)![1]) {
      if (!(group === SAVINGS[0] && code === SAVINGS[1])) out.push([group, code, description]);
    }
  }
  return out;
}
