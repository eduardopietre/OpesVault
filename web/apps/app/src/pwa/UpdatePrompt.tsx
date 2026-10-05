/**
 * PWA (docs/18 W7): the app shell works offline and a new version is announced, never applied in silence
 * (an open project may have changes still being sent). API responses are never cached by the worker.
 */
import { notify } from "@opesvault/ui";
import { useEffect, useRef } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });
  const announced = useRef(false);

  useEffect(() => {
    if (!offlineReady) return;
    notify("Pronto para abrir sem conexão neste aparelho.", { tone: "positive" });
    setOfflineReady(false);
  }, [offlineReady, setOfflineReady]);

  useEffect(() => {
    if (!needRefresh || announced.current) return;
    announced.current = true;
    notify("Há uma versão nova do OpesVault.", {
      duration: 0,
      action: {
        label: "Atualizar",
        run: () => {
          setNeedRefresh(false);
          void updateServiceWorker(true);
        },
      },
    });
  }, [needRefresh, setNeedRefresh, updateServiceWorker]);

  return null;
}
