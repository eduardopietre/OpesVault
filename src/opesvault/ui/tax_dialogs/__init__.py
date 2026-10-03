"""Dialogs of the Imposto de renda page: tax ids, people, natures, payslips, assets, informes,
the year's table, variable income rules and DARF payments.

One module per sheet of the return; this package's names are the ones the pages import.
"""

from opesvault.ui.tax_dialogs.assets import DeclaredAssetDialog, FilingDialog
from opesvault.ui.tax_dialogs.income import IncomeDetailDialog, NatureDialog, OperationsDialog
from opesvault.ui.tax_dialogs.people import MemberTaxDialog, PeopleDialog, TaxIdDialog
from opesvault.ui.tax_dialogs.reports import ReportDialog
from opesvault.ui.tax_dialogs.year import ParametersDialog, PaymentDialog, VariableRulesDialog

__all__ = [
    "DeclaredAssetDialog",
    "FilingDialog",
    "IncomeDetailDialog",
    "MemberTaxDialog",
    "NatureDialog",
    "OperationsDialog",
    "ParametersDialog",
    "PaymentDialog",
    "PeopleDialog",
    "ReportDialog",
    "TaxIdDialog",
    "VariableRulesDialog",
]
