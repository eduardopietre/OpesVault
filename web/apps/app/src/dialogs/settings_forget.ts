/**
 * Esquecer este aparelho: the question asked before the local copy is erased. It says what goes away (the
 * encrypted copy and the preferences of this device), what does not (the project on the server) and, when there
 * are changes not yet sent, that those would be lost.
 */
import { confirm } from "@opesvault/ui";

export function askForgetDevice(pending: number): Promise<boolean> {
  const lost =
    pending > 0
      ? ` Há ${pending === 1 ? "1 alteração" : `${pending} alterações`} ainda não enviada${pending === 1 ? "" : "s"} ao servidor: ${
          pending === 1 ? "ela será perdida" : "elas serão perdidas"
        }.`
      : "";
  return confirm({
    title: "Esquecer este aparelho?",
    text: `O projeto é bloqueado, a cópia cifrada deste navegador e as preferências deste aparelho são apagadas e a sua conta sai daqui. O projeto continua no servidor e abre de novo com a senha.${lost}`,
    confirmLabel: "Esquecer este aparelho",
    danger: true,
  });
}
