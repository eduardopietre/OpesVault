"""What the user reads when a vault operation fails: one sentence per error code, no data."""

from PySide6.QtWidgets import QMessageBox, QWidget

from opesvault.vault.errors import ErrorCode

ERROR_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.CANCELLED: "Operação cancelada. Nada foi alterado.",
    ErrorCode.WRONG_PASSWORD: "Senha incorreta. O arquivo não foi alterado.",
    ErrorCode.NOT_FOUND: "Arquivo do cofre não encontrado.",
    ErrorCode.ALREADY_EXISTS: "Já existe um arquivo com esse nome.",
    ErrorCode.NOT_A_VAULT: "O arquivo não é um cofre OpesVault válido.",
    ErrorCode.INCOMPATIBLE_FORMAT: "Este cofre foi criado por uma versão mais nova do OpesVault.",
    ErrorCode.REVISION_MISMATCH: "O cofre foi alterado fora desta sessão. Nada foi sobrescrito.",
    ErrorCode.VERIFY_FAILED: "A verificação da nova versão falhou. O cofre anterior foi mantido.",
    ErrorCode.REPLACE_FAILED: (
        "Não foi possível substituir o arquivo (antivírus ou permissão?). O cofre anterior foi mantido."
    ),
    ErrorCode.LOCKED: "Este cofre já está aberto em outra janela do OpesVault.",
    ErrorCode.IO_ERROR: "Erro de leitura ou gravação (disco cheio ou removido?).",
    ErrorCode.INTERNAL: (
        "A operação falhou por um erro interno. Os dados abertos continuam na memória; tente de novo. "
        "Se repetir, o registro técnico guarda o código, sem dados financeiros."
    ),
    ErrorCode.PROTOCOL_ERROR: ("A comunicação com o processo do cofre falhou. Nada foi gravado; tente de novo."),
    ErrorCode.UNCERTAIN: (
        "Não foi possível confirmar o salvamento. Reabra o cofre para conferir antes de tentar de novo."
    ),
}


def show_error(parent: QWidget, code: ErrorCode) -> None:
    """A cancelled operation needs no message: the user chose it."""
    if code is ErrorCode.CANCELLED:
        return
    QMessageBox.warning(parent, "OpesVault", ERROR_MESSAGES.get(code, f"Erro inesperado ({code})."))
