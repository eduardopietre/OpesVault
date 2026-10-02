"""Contextual help (F1). Local text only: no browser, no network (docs/02 §6)."""

GENERAL = """
<h3>Atalhos gerais</h3>
<table>
<tr><td><b>Ctrl+N</b></td><td>Novo cofre</td></tr>
<tr><td><b>Ctrl+O</b></td><td>Abrir cofre</td></tr>
<tr><td><b>Ctrl+S</b></td><td>Salvar (a senha é pedida a cada salvamento)</td></tr>
<tr><td><b>Ctrl+W</b></td><td>Fechar cofre</td></tr>
<tr><td><b>Ctrl+1 … Ctrl+9</b></td><td>Ir para a seção correspondente (menu Ir)</td></tr>
<tr><td><b>Ctrl+F</b></td><td>Buscar na tela atual</td></tr>
<tr><td><b>Ctrl+Shift+B</b></td><td>Mostrar ou ocultar a barra lateral</td></tr>
<tr><td><b>Alt+← / Alt+→</b></td><td>Mês anterior / próximo (Visão geral)</td></tr>
<tr><td><b>Ctrl+L</b></td><td>Ocultar o conteúdo agora (bloqueio visual)</td></tr>
<tr><td><b>F1</b></td><td>Ajuda da tela atual</td></tr>
</table>
<p>O OpesVault funciona sem internet. Os dados ficam só no arquivo <code>.opesvault</code>, cifrado com a sua senha.
Não existe recuperação de senha: guarde backups e a senha com cuidado.</p>
"""

PAGES: dict[str, str] = {
    "Visão geral": """
<p>Resumo do mês: saldos das contas, faturas abertas, receitas e despesas por competência e pendências.</p>
<p>Valores desconhecidos aparecem como “—”, nunca como zero. Clique nos gráficos para ver de onde vem cada número.</p>
""",
    "Livro financeiro": """
<p>Todos os lançamentos em partidas dobradas. Cada operação tem débitos e créditos que se equilibram.</p>
<ul>
<li><b>Filtros</b>: período, conta ou categoria, integrante, situação, origem e texto (descrição e observações).</li>
<li><b>Busca</b> (Ctrl+F) e <b>Limpar filtros</b>, que aparece quando algum filtro está ativo.</li>
<li><b>Detalhes</b>: o painel à direita mostra datas, partidas, rateio e histórico do lançamento selecionado.
Clique com o botão direito no cabeçalho da tabela para escolher as colunas.</li>
<li><b>Editar</b> (duplo clique, Enter ou botão direito): datas, competência, responsável, observações e partidas,
incluindo o rateio por integrante. O indicador mostra se débitos e créditos fecham.</li>
<li><b>Reclassificar selecionados</b>: troca a categoria de vários lançamentos de uma vez.
Selecione com Shift ou Ctrl. Rateios com mais de uma categoria não são alterados.</li>
<li><b>Estornar</b> cria uma operação oposta; <b>Cancelar</b> tira o lançamento das contas.
Toda correção exige um motivo e fica no histórico.</li>
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
<tr><td><b>Ctrl+Enter</b></td><td>Aprovar o item selecionado e ir ao próximo</td></tr>
<tr><td><b>Ctrl+Shift+Enter</b></td><td>Aprovar todos os itens prontos</td></tr>
<tr><td><b>F2</b></td><td>Corrigir o item</td></tr>
<tr><td><b>Ctrl+M</b></td><td>Manter como lançamento separado</td></tr>
<tr><td><b>Delete</b></td><td>Rejeitar o item</td></tr>
</table>
<p>A IA local (Ollama) é opcional e só sugere categorias; nada é gravado sem a sua aprovação.</p>
""",
    "Contas e cartões": """
<p>Cadastro de contas, cartões, adicionais e categorias. Faturas são calculadas pelos dias de fechamento e vencimento
e comparadas ao total do documento importado.</p>
<p>O fechamento mensal bloqueia alterações no mês; a reabertura exige motivo.</p>
""",
    "Recorrências": """
<p>Regras de contas fixas e receitas previstas. Previsões nunca alteram saldos: elas só viram lançamento quando
você confirma o vínculo com o realizado.</p>
""",
    "Investimentos": """
<p>Posições por valor ou por quantidade, avaliações, aportes, resgates, proventos e notas de corretagem.</p>
<p>Avaliação não é fluxo e aporte não é rendimento. Quando faltam dados, o resultado aparece como indisponível,
com o motivo. TWR, XIRR e Dietz só são calculados quando os dados permitem.</p>
""",
    "Relatórios": """
<p>Fluxo de caixa, resultado por competência, despesas por categoria e patrimônio. Cada valor dos gráficos pode
ser inspecionado até os lançamentos que o compõem.</p>
""",
    "Documentos": """
<p>Arquivos guardados no cofre e os lançamentos ligados a cada um.
Os documentos nunca são gravados em disco sem cifra.</p>
""",
    "Configurações": """
<p>Pasta e retenção de backups, lembrete de salvamento, IA local e o catálogo de layouts suportados.
Layouts marcados como não validados com documentos reais exibem um aviso a cada importação.</p>
""",
}


def help_for(title: str) -> str:
    body = PAGES.get(title, "<p>Sem ajuda específica para esta tela.</p>")
    return f"<h2>{title}</h2>{body}<hr>{GENERAL}"
