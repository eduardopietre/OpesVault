/**
 * Configurações (desktop `ui/pages/settings_page.py`, adapted to the web): what belongs to the project (it is
 * the same for everyone and syncs) and what belongs to this device (written at once, outside the project).
 * Each block says which it is. Tabs separate different objects: the project, the local AI, security, the backup
 * and this device. A link from another screen opens its section ("ia", "seguranca", "backup", "privacidade").
 */
import { PageHeader, Tabs, useMotionPreset, type TabItem } from "@opesvault/ui";
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useReveal } from "../../data/navigation.ts";
import { AiTab } from "./ai.tsx";
import { BackupTab } from "./backup.tsx";
import { PrivacyTab } from "./privacy.tsx";
import { ProjectTab } from "./project.tsx";
import { SecurityTab } from "./security.tsx";
import { TAB_IDS, TAB_LABELS, parseTab, type TabId } from "./rows.ts";

/** The tab appears with a short fade: it mounts fresh each time it is chosen. */
function TabPanel({ children }: { children: ReactNode }) {
  const preset = useMotionPreset();
  return <motion.div {...preset.enter}>{children}</motion.div>;
}

export function Page() {
  const [tab, setTab] = useState<TabId>("projeto");
  useReveal((ref) => {
    const target = parseTab(ref);
    if (target) setTab(target);
  });
  const content: Record<TabId, ReactNode> = {
    projeto: <ProjectTab />,
    ia: <AiTab />,
    seguranca: <SecurityTab />,
    backup: <BackupTab />,
    privacidade: <PrivacyTab />,
  };
  const tabs: TabItem[] = TAB_IDS.map((id) => ({
    id,
    label: TAB_LABELS[id],
    content: <TabPanel>{content[id]}</TabPanel>,
  }));
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Configurações"
        context="O projeto vale para todos e sincroniza; as preferências valem só neste aparelho e são gravadas na hora."
      />
      <Tabs tabs={tabs} value={tab} onValueChange={(id) => setTab(id as TabId)} label="Configurações" />
    </div>
  );
}
