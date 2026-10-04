"""Contextual help (F1). Local text only: no browser, no network (docs/02 §6)."""

GENERAL = """
<h3>Atalhos gerais</h3>
<table>
<tr><td><b>Ctrl+N</b></td><td>Novo cofre</td></tr>
<tr><td><b>Ctrl+O</b></td><td>Abrir cofre</td></tr>
<tr><td><b>Ctrl+S</b></td><td>Salvar (a senha é pedida a cada salvamento)</td></tr>
<tr><td><b>Ctrl+W</b></td><td>Fechar cofre</td></tr>
<tr><td><b>Ctrl+Z / Ctrl+Shift+Z</b></td><td>Desfazer / refazer o que ainda não foi salvo</td></tr>
<tr><td><b>Ctrl+1 … Ctrl+9</b></td><td>Ir para a seção correspondente (menu Ir)</td></tr>
<tr><td><b>Ctrl+F</b></td><td>Buscar na tela atual</td></tr>
<tr><td><b>Ctrl+Shift+B</b></td><td>Mostrar ou ocultar a barra lateral</td></tr>
<tr><td><b>Alt+← / Alt+→</b></td><td>Mês anterior / próximo (Visão geral)</td></tr>
<tr><td><b>Ctrl+L</b></td><td>Ocultar o conteúdo agora (bloqueio visual)</td></tr>
<tr><td><b>F1</b></td><td>Ajuda da tela atual</td></tr>
</table>
<p>Arraste arquivos (PDF, CSV, OFX) para qualquer tela para importá-los. <b>Cofre › Verificar backup</b> abre
um backup (com a senha dele) e confirma que está íntegro, sem mexer no cofre aberto.</p>
<p>O OpesVault funciona sem internet. Os dados ficam só no arquivo <code>.opesvault</code>, cifrado com a sua senha.
Não existe recuperação de senha: guarde backups e a senha com cuidado.</p>
"""

PAGES: dict[str, str] = {
    "Visão geral": """
<p><b>Atenção</b> lista faturas e contas que vencem nos próximos 7 dias, o que está atrasado, orçamentos
estourados e importações aguardando revisão. Aparece sempre que o cofre é aberto.</p>
<p>Cada aviso tem um botão que abre o ponto exato: a fatura com <b>Pagar</b>, a previsão atrasada com
<b>Vincular</b>, a categoria no orçamento do mês, o documento na revisão.</p>
<p>Resumo do mês: caixa, resultado por competência, patrimônio, saldos das contas e despesas por categoria.
Clique numa conta ou categoria para ver os lançamentos daquele mês no Livro financeiro.</p>
<p>O mês escolhido aqui vale também no Orçamento e na opção de mês do Livro financeiro.
<b>Antes de fechar o mês</b> lista o que impede o fechamento.</p>
<p><b>Indicadores</b>: taxa de poupança do mês e de 12 meses, parte fixa das despesas, renda comprometida com
parcelas e quantos meses de despesa a reserva cobre. Cada um diz como é calculado; sem dados, aparece “—”.</p>
<p><b>Comparado aos meses anteriores</b>: o mês contra a média dos 3 meses anteriores e contra o mesmo mês do ano
anterior, com as categorias que mais subiram. <b>Mês a mês</b> mostra o gráfico e, abaixo, a tabela com os mesmos
valores. Cada seção pode ser recolhida clicando no título; a escolha fica neste computador.</p>
<p><b>Visão de</b>: o projeto inteiro ou um integrante. Na visão de um integrante, a competência mostra as partes
atribuídas a ele (rateio) e o caixa e o patrimônio mostram as contas de que é titular; contas conjuntas aparecem
inteiras, por isso as visões dos integrantes não somam a do projeto.</p>
<p><b>Relatório em PDF</b>: resumo, comparação, categorias com o orçamento, vencimentos, indicadores e pendências do
mês, para conversar sobre o projeto. O arquivo sai sem cifra; o aplicativo avisa antes.</p>
<p>Valores desconhecidos aparecem como “—”, nunca como zero.</p>
""",
    "Calendário": """
<p>Faturas de cartão, contas recorrentes e parcelas de financiamento do mês, dia a dia. Dias com vencimento ficam
em negrito; os atrasados, em destaque, com a situação escrita na lista.</p>
<p>Clique num dia para ver só os seus vencimentos (<b>Mês inteiro</b> volta à lista do mês). <b>Abrir…</b> (ou
duplo clique) leva à tela onde se paga a fatura ou a parcela, ou se vincula a conta ao lançamento.</p>
<p>Compras parceladas no cartão aparecem dentro da fatura. Previsões nunca alteram saldos.</p>
""",
    "Metas": """
<p>Metas de patrimônio líquido ou de saldo de contas escolhidas (reserva de emergência, entrada de um imóvel).
A tabela mostra o valor atual, o alvo, o progresso e quanto falta; com prazo, quanto é preciso guardar por mês.
<b>Ritmo recente</b> é quanto o valor mudou por mês, em média, nos últimos meses com registros, e <b>Alcança em</b>
diz quando a meta é atingida nesse ritmo. Abaixo, o gráfico e a tabela da meta selecionada, mês a mês.</p>
<p>A meta só acompanha valores que o livro já tem: não reserva nem movimenta dinheiro.</p>
""",
    "Reembolsos e acertos": """
<p><b>Reembolsos</b>: despesas que o plano de saúde, a empresa ou outra pessoa vai devolver. Marque no Livro
financeiro (Ações › Reembolso a receber). Ao receber, o valor entra como estorno das mesmas categorias, no mês do
recebimento, e a despesa líquida fica certa.</p>
<p><b>Acertos entre integrantes</b>: numa despesa com rateio, quem pagou adiantou a parte dos outros. Paga quem é o
único titular da conta de onde saiu o dinheiro, ou o titular do cartão; conta conjunta não gera dívida. Registrar o
acerto só anota que a dívida foi paga; a transferência, se houver, é um lançamento normal.</p>
""",
    "Imposto de renda": """
<p>O ano organizado como as fichas da declaração: rendimentos por fonte pagadora, isentos e exclusivos,
pagamentos dedutíveis, bens pelo custo de aquisição e dívidas em 31/12. É <b>material de apoio</b>: a natureza de
cada receita, o grupo e o código dos bens e todas as alíquotas e tabelas são informados por você; nada vem
embutido nem é classificado sozinho.</p>
<ul>
<li><b>Declarante</b>: cada declaração é de um CPF. Em Cadastros › Declarantes e dependentes, diga quem declara
quem; a página mostra o declarante com os dependentes dele.</li>
<li><b>Pendências</b>: CPF ou CNPJ faltando, comprovante não anexado, informe diferente do registrado, receita sem
natureza, DARF não registrado. <b>Resolver…</b> abre o lugar da correção.</li>
<li><b>Informes</b>: importe o PDF do banco, da corretora ou do empregador. A leitura acontece fora da tela, você
confere cada linha e o original fica cifrado no cofre; depois, cada valor é comparado com o registrado.</li>
<li><b>Contracheques</b>: bruto, imposto retido e INSS de cada depósito de salário (também no Livro, Ações ›
Detalhar rendimento). Sem eles, o depósito conta pelo valor líquido.</li>
<li><b>Renda variável</b>: vendas de ações, ETF e fundos imobiliários mês a mês, com prejuízo compensado nos meses
seguintes e o DARF a pagar, usando as alíquotas e o limite de isenção que você informar.</li>
<li><b>Carnê-Leão</b>: receitas de pessoa física ou do exterior, mês a mês; o imposto é calculado no Carnê-Leão
Web, e aqui se registra o pagamento. Os vencimentos aparecem em Atenção.</li>
<li><b>Simplificada ou completa</b>: simulação com a tabela anual e os limites que você copiar da fonte oficial.</li>
</ul>
<p>CPF e CNPJ ficam só dentro do cofre. O relatório em PDF (Mais) sai sem criptografia, com aviso.</p>
""",
    "Orçamento": """
<p>Quanto você planeja gastar por categoria em cada mês, quanto já gastou e quanto resta.</p>
<ul>
<li>O realizado segue a competência: compra no cartão conta no mês em que aconteceu; o pagamento da fatura não
repete a despesa; estornos do lojista reduzem o gasto.</li>
<li>Orçamento de uma categoria-mãe inclui as subcategorias.</li>
<li><b>Copiar do mês anterior</b> repete o plano sem apagar o que já foi definido.</li>
<li>Ao passar de 90% a categoria aparece como “perto do limite”; acima de 100%, “estourado”. O aviso aparece
também ao abrir o cofre e na barra de status quando um lançamento estoura o plano.</li>
<li><b>Planejado e realizado mês a mês</b>: o gráfico e a tabela dos últimos meses, da categoria selecionada ou
de todo o orçamento. Meses sem orçamento ficam vazios, não zerados.</li>
</ul>
""",
    "Livro financeiro": """
<p>Todos os lançamentos em partidas dobradas. Cada operação tem débitos e créditos que se equilibram.</p>
<ul>
<li><b>Filtros</b>: período, conta ou categoria, integrante, situação, origem e texto (descrição e observações).</li>
<li><b>Busca</b> (Ctrl+F) e <b>Limpar filtros</b>, que aparece quando algum filtro está ativo.</li>
<li><b>Detalhes</b>: o painel à direita mostra datas, partidas, rateio e histórico do lançamento selecionado.
Clique com o botão direito no cabeçalho da tabela para escolher as colunas.</li>
<li><b>Corrigir</b> (duplo clique, Enter ou botão direito): o mesmo formulário de receita, despesa,
transferência, compra ou pagamento, com valor, data, conta, categoria e competência.</li>
<li><b>Corrigir partidas</b>: o editor completo, com datas, débitos e créditos e o rateio por integrante.
O indicador mostra se débitos e créditos fecham.</li>
<li><b>Reclassificar selecionados</b>: troca a categoria de vários lançamentos de uma vez.
Selecione com Shift ou Ctrl. Rateios com mais de uma categoria não são alterados.</li>
<li><b>Estornar</b> cria uma operação oposta; <b>Cancelar</b> tira o lançamento das contas.
Toda correção exige um motivo e fica no histórico.</li>
<li><b>Marcadores</b> (Ações › Marcadores…): agrupam lançamentos de várias categorias, como uma viagem ou uma
reforma. Não mudam valores e valem também em meses fechados; uma compra parcelada é marcada inteira. Filtre por
marcador e veja o total em Relatórios › Marcadores.</li>
<li><b>Reembolso a receber</b>: marca uma despesa que alguém vai devolver (Reembolsos e acertos).</li>
<li><b>Anexar comprovante</b>: um PDF ou foto (PNG, JPEG) do recibo, guardado cifrado no cofre e visto em
Documentos. Vale para qualquer lançamento, inclusive de mês fechado.</li>
<li><b>Nomear estabelecimento</b>: “IFD*IFOOD.COM AGENCIA” vira “iFood” em todos os lançamentos parecidos; a
descrição do banco continua guardada. Relatórios › Despesas por estabelecimento usa esses nomes.</li>
<li><b>Sugerir categorias com IA</b> e <b>Sugerir nomes de estabelecimentos com IA</b> (com a IA local ligada):
olham os lançamentos selecionados (dois ou mais) ou, sem seleção, todos os exibidos pelos filtros. A resposta vem
numa lista em que cada mudança pode ser desmarcada, e um nome pode ser ajustado com dois cliques; nada muda antes de
você aplicar. A reclassificação guarda no histórico o motivo e o modelo que sugeriu.</li>
<li><b>Está certo</b>: silencia os avisos de possível cobrança duplicada ou de valor fora do comum.</li>
<li><b>Filtros salvos</b>: guarda a combinação atual de filtros com um nome (“Cartão da Ana este mês”), no
cofre, para aplicar depois com um clique.</li>
<li>Meses fechados não aceitam alterações até serem reabertos com motivo.</li>
</ul>
""",
    "Importar e revisar": """
<p>Importe faturas e extratos em PDF, CSV ou OFX. O arquivo original fica guardado no cofre, cifrado.</p>
<p>Cada item mostra a evidência no documento. Itens duplicados ou parcelas já registradas são sinalizados.
Divergência de total bloqueia a aprovação, salvo com motivo.</p>
<h3>Atalhos da revisão</h3>
<table>
<tr><td><b>Ctrl+I</b></td><td>Importar arquivos</td></tr>
<tr><td><b>↑ / ↓</b></td><td>Item anterior / próximo</td></tr>
<tr><td><b>Ctrl+K</b></td><td>Escolher categoria do item</td></tr>
<tr><td><b>Ctrl+R</b></td><td>Criar regra de categoria a partir do item</td></tr>
<tr><td><b>Ctrl+Enter</b></td><td>Aprovar o item selecionado e ir ao próximo</td></tr>
<tr><td><b>Ctrl+Shift+Enter</b></td><td>Aprovar todos os itens prontos</td></tr>
<tr><td><b>F2</b></td><td>Corrigir o item</td></tr>
<tr><td><b>Ctrl+M</b></td><td>Manter como lançamento separado</td></tr>
<tr><td><b>Delete</b></td><td>Rejeitar o item</td></tr>
</table>
<p><b>Regras de categoria:</b> ao escolher a categoria de um item, o OpesVault oferece criar uma regra
(“a descrição contém… → categoria”). Regras ficam em Contas e cartões › Regras e só sugerem; a escolha feita à
mão sempre prevalece.</p>
<p>A IA local (Ollama) é opcional e só sugere categorias; nada é aprovado sem você. Ligada em Configurações ›
IA local, ela consulta sozinha os itens sem categoria depois de cada importação, usando como exemplo o que você já
classificou. Enquanto isso você pode seguir revisando; a sua escolha sempre prevalece. A origem de cada sugestão
aparece no item (“sugestão (IA local, modelo)”). A mesma IA também atende o Livro (outra categoria e nomes de
estabelecimentos) e o Novo lançamento (<b>Perguntar à IA local</b>, quando o histórico não conhece a descrição).</p>
""",
    "Contas e cartões": """
<p>Cadastro de contas, cartões, adicionais e categorias. Faturas são calculadas pelos dias de fechamento e vencimento
e comparadas ao total do documento importado; o gráfico acima da tabela mostra as faturas mês a mês.</p>
<p><b>Contas</b>: abaixo da lista, o saldo da conta selecionada no fim de cada mês (gráfico e tabela) e as
<b>conferências com o banco</b>. Em <b>Conferir saldo…</b> você digita o saldo do extrato numa data; o aplicativo
compara com o seu saldo na mesma data. Diferença indica lançamento faltando ou errado: nada é ajustado sozinho.</p>
<p><b>Financiamentos</b>: o contrato (saldo devedor, taxa, prazo, SAC ou Price e vencimento), o cronograma
calculado, o saldo devedor e os juros que faltam. <b>Pagar parcela…</b> separa amortização, juros e seguros.
A amortização antecipada é simulada enquanto você digita (reduzir prazo ou parcela) e só é registrada quando
você confirma. O saldo da conta no livro é a referência; diferenças de centavos com o banco são normais.</p>
<p><b>Categorias</b>: <b>Dedutível no IR…</b> marca categorias de saúde, educação, previdência (PGBL) e outras.
O total por pessoa aparece em Relatórios › Despesas dedutíveis, como apoio à declaração.</p>
<p>O fechamento mensal bloqueia alterações no mês; a reabertura exige motivo.</p>
""",
    "Recorrências": """
<p>Regras de contas fixas e receitas previstas. Previsões nunca alteram saldos: elas só viram lançamento quando
você confirma o vínculo com o realizado.</p>
<p><b>Assinaturas e contas fixas</b>: o custo de cada uma por ano e a última cobrança; “Valor mudou” quando o
cobrado difere do previsto ou da cobrança anterior. <b>Parecem recorrentes</b>: cobranças com a mesma descrição em
meses seguidos, sem recorrência; <b>Criar recorrência…</b> já vem preenchido.</p>
""",
    "Investimentos": """
<p>Posições por valor ou por quantidade, avaliações, aportes, resgates, proventos e notas de corretagem.</p>
<p>Avaliação não é fluxo e aporte não é rendimento. Quando faltam dados, o resultado aparece como indisponível,
com o motivo. TWR, XIRR e Dietz só são calculados quando os dados permitem.</p>
<p>O investimento selecionado aparece numa página só: evolução, avaliações, resultado, movimentos, lotes e
rentabilidade, cada um numa seção que se recolhe clicando no título.</p>
""",
    "Relatórios": """
<p>Fluxo de caixa, resultado por competência, despesas por categoria, patrimônio, saldo projetado, comparação com
a média, marcadores e despesas dedutíveis. Cada gráfico tem abaixo a tabela com os mesmos valores (com total e
média nos fluxos mensais), que pode ser exportada em CSV. Gráfico e tabela se recolhem pelo título.</p>
<p>Clique num ponto ou numa linha da tabela para ver de onde vem o valor e abrir os lançamentos.</p>
<p><b>Saldo projetado</b>: o saldo de hoje de cada conta mais o que já está registrado para vir (recorrências,
faturas e parcelas). É previsão: não altera saldos e não adivinha compras que ainda não existem.</p>
<p><b>Despesas dedutíveis</b> é material de apoio: não aplica limites legais nem substitui a declaração.</p>
<p><b>Fechamento do ano</b>: bens e dívidas em 31/12 (com o ano anterior na tabela) e o <b>Relatório anual
(PDF)</b> com receitas por categoria, proventos, imposto retido, ganhos realizados e dedutíveis por pessoa. Também
é material de apoio: não classifica rendimentos como isentos ou tributáveis.</p>
""",
    "Assistente": """
<p>Pergunte sobre o projeto em português (“quanto gastei com mercado em março?”) ou peça uma mudança
(“reclassifique os Uber para Transporte”). O assistente é a IA local (Ollama) com as ferramentas do OpesVault:
ele consulta lançamentos, contas, categorias, orçamento, marcadores, regras e itens importados.</p>
<p><b>Toda alteração pede a sua aprovação</b>: a janela “Aprovar alteração” diz exatamente o que muda; recusar não
muda nada. O que você aprova vira um passo de desfazer (Ctrl+Z), e reclassificações guardam no histórico que vieram do
assistente. Respostas inválidas do modelo voltam para ele como erro; depois de três seguidas, a pergunta é
interrompida.</p>
<p>Requer a IA local ligada em Configurações e um modelo que aceite ferramentas. CPF e CNPJ ficam fora do alcance do
assistente, e a conversa não é gravada: some ao fechar o cofre.</p>
""",
    "Documentos": """
<p>Arquivos guardados no cofre e os lançamentos ligados a cada um: documentos importados e comprovantes anexados
no Livro financeiro (PDF e fotos). Os documentos nunca são gravados em disco sem cifra.</p>
""",
    "Configurações": """
<p><b>Backup e salvamento</b> e <b>IA local</b> ficam no cofre: a mudança vale na hora e é gravada com
Salvar (Ctrl+S), como qualquer outra alteração. <b>Privacidade deste computador</b> (cofres recentes e bloqueio
por inatividade) fica fora do cofre e é gravada na hora.</p>
<p>Fazer backup, restaurar e trocar a senha também estão no menu Cofre. Os layouts suportados ficam em
Importar e revisar.</p>
""",
}


def help_for(title: str) -> str:
    body = PAGES.get(title, "<p>Sem ajuda específica para esta tela.</p>")
    return f"<h2>{title}</h2>{body}<hr>{GENERAL}"
